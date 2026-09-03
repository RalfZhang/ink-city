//! Linux-only: handing the rendered PNG to whatever is drawing the desktop.
//!
//! `wallpaper_set` covers macOS with one AppKit call and Windows with one
//! `SystemParametersInfo`, because on those systems "the desktop" is a single
//! documented API. Linux has no such thing — the wallpaper belongs to whichever
//! shell, file manager or bare compositor happens to be running — so this module
//! is a dispatch table keyed on `XDG_CURRENT_DESKTOP`, and every arm shells out
//! to that desktop's own configuration tool rather than talking a protocol.
//!
//! Three desktops are first-class, on both X11 and Wayland; everything below
//! them in `best_effort_set` is a courtesy that may or may not be there:
//!
//!   - **GNOME** and its derivatives (Unity, Pantheon, Budgie, Pop, Zorin, Ubuntu)
//!     — `gsettings`, *both* `picture-uri` and `picture-uri-dark`.
//!   - **KDE Plasma** — a Plasma script evaluated over the session bus.
//!   - **XFCE** — `xfconf-query`, once per backdrop property.
//!
//! This is deliberately not the `wallpaper` crate (still used for Windows). Its
//! Linux backend writes only `picture-uri`, so GNOME in dark mode — the default
//! on several distributions — never changes image; it drives Plasma through
//! `qdbus`, which Plasma 6 doesn't ship under that name; and its bare-compositor
//! fallback spawns a fresh unmanaged `swaybg` on every call, which for a
//! once-a-day wallpaper app means one leaked process per day.

use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use anyhow::{anyhow, Result};

/// Apply `path` as the desktop wallpaper, cover-fitting it (the renderer already
/// drew it at exactly the screen's pixel size, so this only matters when the
/// screen changes under us).
pub fn set(path: &str) -> Result<()> {
    let desktops = current_desktops();

    if desktops.iter().any(|d| is_gnome_family(d)) {
        return gnome_set(path);
    }
    if desktops.iter().any(|d| d == "KDE" || d == "PLASMA") {
        return kde_set(path);
    }
    if desktops.iter().any(|d| d == "XFCE") {
        return xfce_set(path);
    }
    best_effort_set(path, &desktops)
}

/// The desktop names advertised for this session, uppercased.
///
/// `XDG_CURRENT_DESKTOP` is a colon-separated *list* — Ubuntu says
/// `ubuntu:GNOME`, so matching the variable as a whole string (what the
/// `wallpaper` crate does) misses it — and Cinnamon prefixes its name with the
/// `X-` vendor marker. Falls back to the two older single-value variables for
/// sessions that predate it.
fn current_desktops() -> Vec<String> {
    let raw = ["XDG_CURRENT_DESKTOP", "XDG_SESSION_DESKTOP", "DESKTOP_SESSION"]
        .iter()
        .find_map(|k| std::env::var(k).ok().filter(|v| !v.trim().is_empty()))
        .unwrap_or_default();
    parse_desktops(&raw)
}

fn parse_desktops(raw: &str) -> Vec<String> {
    raw.split(':')
        .map(|d| d.trim().to_ascii_uppercase())
        .map(|d| d.strip_prefix("X-").unwrap_or(&d).to_string())
        .filter(|d| !d.is_empty())
        .collect()
}

/// Desktops that ship the stock `org.gnome.desktop.background` schema and read it.
fn is_gnome_family(desktop: &str) -> bool {
    matches!(desktop, "GNOME" | "GNOME-CLASSIC" | "GNOME-FLASHBACK" | "UNITY" | "PANTHEON")
        || matches!(desktop, "BUDGIE" | "BUDGIE-DESKTOP" | "POP" | "ZORIN" | "UBUNTU")
}

/// `file://` URI for a filesystem path.
///
/// Percent-encodes everything outside the unreserved set, because GLib parses
/// these back into a path: a home directory containing a space or a non-ASCII
/// character (`/home/andré/…`) yields an unparseable URI otherwise, and GNOME
/// answers that by drawing a plain grey desktop. `/` is left alone so the result
/// stays a readable path in logs, and `%` itself is encoded, so the mapping is
/// unambiguous even for a path that already contains one.
fn file_uri(path: &str) -> String {
    let mut out = String::from("file://");
    for b in path.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

// ---------------------------------------------------------------- GNOME family

fn gnome_set(path: &str) -> Result<()> {
    const SCHEMA: &str = "org.gnome.desktop.background";
    let uri = file_uri(path);

    // Cover-fit, matching the macOS (`AllowClipping` + scaling 3) and Windows
    // (`Mode::Crop`) arms.
    if let Err(e) = gsettings(SCHEMA, "picture-options", "zoom") {
        log::debug!("[wallpaper] gnome picture-options: {e}");
    }

    // `picture-uri-dark` is the key GNOME actually reads while the user is in
    // dark mode, and dark is the default on several distributions — so writing
    // only `picture-uri` leaves those desktops on yesterday's image forever.
    // It arrived in GNOME 42 and `gsettings` exits non-zero for a key the
    // installed schema doesn't have, so it can't be what we gate success on;
    // `picture-uri` can, since it has existed for the schema's whole life.
    if let Err(e) = gsettings(SCHEMA, "picture-uri-dark", &uri) {
        log::debug!("[wallpaper] no picture-uri-dark (pre-GNOME 42?): {e}");
    }
    gsettings(SCHEMA, "picture-uri", &uri)
}

// ----------------------------------------------------------------- KDE Plasma

/// Plasma keeps the wallpaper in the shell's own applet config, reachable only
/// by asking plasmashell to evaluate a script.
///
/// Driven with `dbus-send` rather than the `qdbus` the `wallpaper` crate uses:
/// Plasma 6 renamed that binary (`qdbus6` on most distributions, `qdbus-qt6` on
/// others) and a bare `qdbus` is usually absent, whereas `dbus-send` comes with
/// dbus itself and so is present wherever the session bus is.
///
/// `wallpaperPlugin` is set as well as the image, so a desktop currently on the
/// slideshow or plain-colour plugin switches over instead of silently ignoring
/// an `org.kde.image` config it isn't reading.
fn kde_set(path: &str) -> Result<()> {
    // FillMode 2 = scaled & cropped, i.e. cover-fit.
    let script = format!(
        r#"for (const d of desktops()) {{
    d.wallpaperPlugin = "org.kde.image";
    d.currentConfigGroup = ["Wallpaper", "org.kde.image", "General"];
    d.writeConfig("Image", "{uri}");
    d.writeConfig("FillMode", "2");
}}"#,
        uri = file_uri(path)
    );

    run(
        "dbus-send",
        &[
            "--session",
            "--type=method_call",
            "--dest=org.kde.plasmashell",
            "/PlasmaShell",
            "org.kde.PlasmaShell.evaluateScript",
            &format!("string:{script}"),
        ],
    )
}

// ----------------------------------------------------------------------- XFCE

/// XFCE holds one backdrop per monitor per workspace, each its own xfconf
/// property, and there is no "all of them" property — so enumerate and write
/// every one, or the wallpaper changes on one workspace and not the next.
///
/// Takes a plain path, not a URI.
fn xfce_set(path: &str) -> Result<()> {
    let props = stdout("xfconf-query", &["-c", "xfce4-desktop", "-l"])?;
    let mut written = 0usize;
    let mut last_err = None;

    for prop in props.lines().map(str::trim).filter(|p| p.ends_with("/last-image")) {
        // image-style 5 = "zoomed", XFCE's cover-fit.
        let style = prop.replace("last-image", "image-style");
        if let Err(e) = run("xfconf-query", &["-c", "xfce4-desktop", "-p", &style, "-s", "5"]) {
            log::debug!("[wallpaper] xfce {style}: {e}");
        }
        match run("xfconf-query", &["-c", "xfce4-desktop", "-p", prop, "-s", path]) {
            Ok(()) => written += 1,
            Err(e) => last_err = Some(e),
        }
    }

    if written > 0 {
        return Ok(());
    }
    // A freshly-installed XFCE that has never had its wallpaper changed can
    // genuinely have no `last-image` property yet, which is why "none found" is
    // an error rather than a silent success.
    Err(last_err
        .unwrap_or_else(|| anyhow!("xfce: no */last-image backdrop property in xfce4-desktop")))
}

// -------------------------------------------------------------- best effort

/// Everything we don't promise. Tried in order of how specific the signal is:
/// a named desktop we recognize, then the generic per-display-server tools.
fn best_effort_set(path: &str, desktops: &[String]) -> Result<()> {
    if desktops.iter().any(|d| d == "CINNAMON") {
        const SCHEMA: &str = "org.cinnamon.desktop.background";
        let _ = gsettings(SCHEMA, "picture-options", "zoom");
        return gsettings(SCHEMA, "picture-uri", &file_uri(path));
    }
    if desktops.iter().any(|d| d == "MATE") {
        const SCHEMA: &str = "org.mate.desktop.background";
        let _ = gsettings(SCHEMA, "picture-options", "zoom");
        // MATE kept the pre-URI key name and still wants a bare path.
        return gsettings(SCHEMA, "picture-filename", path);
    }
    if desktops.iter().any(|d| d == "DEEPIN") {
        const SCHEMA: &str = "com.deepin.wrap.gnome.desktop.background";
        let _ = gsettings(SCHEMA, "picture-options", "zoom");
        return gsettings(SCHEMA, "picture-uri", &file_uri(path));
    }
    if desktops.iter().any(|d| d == "LXQT") {
        return run("pcmanfm-qt", &["--set-wallpaper", path, "--wallpaper-mode", "crop"]);
    }
    if desktops.iter().any(|d| d == "LXDE") {
        return run("pcmanfm", &["--set-wallpaper", path, "--wallpaper-mode", "crop"]);
    }

    if is_wayland() {
        wlroots_set(path)
    } else {
        x11_set(path)
    }
}

fn is_wayland() -> bool {
    std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var("XDG_SESSION_TYPE")
            .map(|t| t.eq_ignore_ascii_case("wayland"))
            .unwrap_or(false)
}

/// Compositors that draw no wallpaper themselves (sway, Hyprland, river, niri…),
/// so a separate program owns a layer surface for it. Tried daemon-first,
/// because a daemon is something we can hand a new image to; `swaybg` is not.
fn wlroots_set(path: &str) -> Result<()> {
    let mut tried = Vec::new();

    // swww: a running daemon, one-shot client. Nothing for us to manage.
    match run("swww", &["img", "--transition-type", "none", path]) {
        Ok(()) => return Ok(()),
        Err(e) => tried.push(e.to_string()),
    }

    // hyprpaper: also a daemon, but it caches every image it is handed in RAM
    // and never evicts, so `unload all` first — otherwise a daily wallpaper
    // grows the compositor's memory by one full-screen bitmap per day.
    match hyprpaper_set(path) {
        Ok(()) => return Ok(()),
        Err(e) => tried.push(e.to_string()),
    }

    match swaybg_set(path) {
        Ok(()) => return Ok(()),
        Err(e) => tried.push(e.to_string()),
    }

    Err(anyhow!("no wayland wallpaper tool worked: {}", tried.join("; ")))
}

fn hyprpaper_set(path: &str) -> Result<()> {
    let _ = run("hyprctl", &["hyprpaper", "unload", "all"]);
    run("hyprctl", &["hyprpaper", "preload", path])?;
    // Empty monitor field = every monitor.
    run("hyprctl", &["hyprpaper", "wallpaper", &format!(",{path}")])
}

/// The one `swaybg` we own, if any.
///
/// `swaybg` has no IPC: the process *is* the wallpaper, so it has to keep
/// running, and a new image means a new process. Nothing reaps the old one for
/// us, so without this handle a wallpaper that changes daily accumulates a
/// process (each holding a layer surface) per day.
static SWAYBG: Mutex<Option<Child>> = Mutex::new(None);

fn swaybg_set(path: &str) -> Result<()> {
    let child = Command::new("swaybg")
        .args(["-m", "fill", "-i", path])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| anyhow!("swaybg: {e}"))?;

    let mut slot = SWAYBG.lock().unwrap();
    // Start the replacement before retiring the incumbent: swaybg draws as soon
    // as its surface is up, so in this order the new image is already on screen
    // (or a frame away) when the old one goes, rather than the desktop flashing
    // empty for however long a process launch takes.
    if let Some(mut old) = slot.replace(child) {
        let _ = old.kill();
        let _ = old.wait(); // reap; a killed child stays a zombie until waited on
    }
    Ok(())
}

/// Bare X11 — no desktop shell, or one we don't know. Both of these set the root
/// pixmap, which is as close to "the wallpaper" as X11 has.
fn x11_set(path: &str) -> Result<()> {
    let first = match run("feh", &["--bg-fill", path]) {
        Ok(()) => return Ok(()),
        Err(e) => e,
    };
    match run("xwallpaper", &["--zoom", path]) {
        Ok(()) => Ok(()),
        Err(e) => Err(anyhow!("no x11 wallpaper tool worked: {first}; {e}")),
    }
}

// -------------------------------------------------------------- process helpers

fn gsettings(schema: &str, key: &str, value: &str) -> Result<()> {
    run("gsettings", &["set", schema, key, value])
}

/// Run `bin` to completion, mapping a non-zero exit into an error that carries
/// the tool's own stderr — the dispatch above has several arms that fall through
/// on failure, and without the message the log says only "it didn't work".
fn run(bin: &str, args: &[&str]) -> Result<()> {
    let out = Command::new(bin).args(args).output().map_err(|e| anyhow!("{bin}: {e}"))?;
    if !out.status.success() {
        return Err(anyhow!(
            "{bin} exited with {:?}: {}",
            out.status.code(),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

fn stdout(bin: &str, args: &[&str]) -> Result<String> {
    let out = Command::new(bin).args(args).output().map_err(|e| anyhow!("{bin}: {e}"))?;
    if !out.status.success() {
        return Err(anyhow!(
            "{bin} exited with {:?}: {}",
            out.status.code(),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ubuntu_advertises_gnome_as_a_list() {
        let d = parse_desktops("ubuntu:GNOME");
        assert_eq!(d, vec!["UBUNTU", "GNOME"]);
        assert!(d.iter().any(|d| is_gnome_family(d)));
    }

    #[test]
    fn cinnamons_vendor_prefix_is_stripped() {
        assert_eq!(parse_desktops("X-Cinnamon"), vec!["CINNAMON"]);
    }

    #[test]
    fn an_unset_variable_yields_no_desktops() {
        assert!(parse_desktops("").is_empty());
        assert!(parse_desktops("  ").is_empty());
    }

    #[test]
    fn plasma_is_recognized_under_both_names() {
        for raw in ["KDE", "plasma"] {
            let d = parse_desktops(raw);
            assert!(d.iter().any(|d| d == "KDE" || d == "PLASMA"), "{raw}");
        }
    }

    #[test]
    fn a_plain_path_survives_uri_encoding_readably() {
        assert_eq!(
            file_uri("/home/ralf/.cache/InkCity/wallpaper/wallpaper-1.png"),
            "file:///home/ralf/.cache/InkCity/wallpaper/wallpaper-1.png"
        );
    }

    #[test]
    fn spaces_and_non_ascii_in_the_path_are_percent_encoded() {
        assert_eq!(file_uri("/home/andré/my pics/a.png"), "file:///home/andr%C3%A9/my%20pics/a.png");
        // A literal '%' must not be left to read as the start of an escape.
        assert_eq!(file_uri("/tmp/100%.png"), "file:///tmp/100%25.png");
    }
}
