//! Handing a rendered PNG to the OS as the desktop wallpaper — the one module that
//! talks to the platform's desktop APIs: osascript/JXA on macOS, the `wallpaper`
//! crate on Windows, and `wallpaper_linux`'s per-desktop dispatch on Linux (see
//! that module for why the crate isn't used there).

use anyhow::{anyhow, Result};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

/// How long a replaced live copy stays on disk before a sweep may remove it.
///
/// The OS doesn't always read the picture when it's told to. On macOS 27,
/// `setDesktopImageURL` returns at once and WallpaperAgent loads the image
/// later — seconds later once its store has bloated (FB25321510), and it can
/// still be working through an earlier request when the next one arrives.
/// Deleted under it, the file it's after fails to load (NSCocoaErrorDomain
/// 260) and the desktop falls back to the system's default picture. That
/// happened when switching Daily ↔ Customized back and forth, with sets a few
/// seconds apart. GNOME loads its picture asynchronously too. A few minutes is
/// far more than any lag seen, and costs only a few MB per copy.
const LIVE_GRACE: Duration = Duration::from_secs(5 * 60);

/// The live copy the OS was last pointed at successfully. Never swept, however
/// old: it's what the desktop shows.
static CURRENT: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Apply `src` as the desktop wallpaper. Copies it to a freshly-timestamped
/// `wallpaper-<ts>.png` in `live_dir` (the `wallpaper/` cache root) and points
/// the OS at that copy, then removes the older `wallpaper-*.png` siblings that
/// are `LIVE_GRACE` old. Younger ones wait for a later set's sweep — with
/// syncing on, every launch sets the wallpaper once (`last_applied` starts
/// empty), so they don't linger past the next one.
///
/// The fresh filename on every call is what makes the change reliably take on
/// macOS — NSWorkspace.setDesktopImageURL caches by URL equality, so re-setting
/// the same path (even after the content changed) is a silent no-op — and it's
/// harmless on Windows, which copies the image into its own store on set, so the
/// source file can be replaced next time without disturbing the live desktop. On
/// Linux it's load-bearing again for the same reason as macOS: GNOME and Plasma
/// both key their wallpaper cache on the path, so a re-set of an unchanged
/// filename shows the previous image.
///
/// When the OS refuses the copy, nothing is swept: the desktop may still be
/// showing an older copy. The next successful set sweeps the refused one.
pub fn set(src: &Path, live_dir: &Path) -> Result<()> {
    std::fs::create_dir_all(live_dir)?;
    let live = fresh_live_path(live_dir);
    std::fs::copy(src, &live)?;
    set_os(&live)?;
    *CURRENT.lock().unwrap() = Some(live);
    sweep_live_files(live_dir);
    Ok(())
}

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn fresh_live_path(dir: &Path) -> PathBuf {
    dir.join(format!("wallpaper-{}.png", now_millis()))
}

/// Remove the `wallpaper-*.png` copies in `dir` that the desktop no longer
/// shows and the OS has had `LIVE_GRACE` to finish reading.
fn sweep_live_files(dir: &Path) {
    let current = CURRENT.lock().unwrap().clone();
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let now = now_millis();
    for e in entries.flatten() {
        let p = e.path();
        if current.as_deref() == Some(p.as_path()) {
            continue;
        }
        let Some(name) = p.file_name().and_then(|n| n.to_str()) else { continue };
        if is_stale_live_copy(name, now) {
            let _ = std::fs::remove_file(&p);
        }
    }
}

/// Whether `name` is a live copy old enough to remove at `now` (ms since the
/// epoch). Its age is the timestamp in its name, the moment it was written. A
/// `wallpaper-*.png` without a readable timestamp is stale. A timestamp in the
/// future (the clock went back) counts as new, so the copy only waits longer.
fn is_stale_live_copy(name: &str, now: u128) -> bool {
    let Some(stem) = name.strip_prefix("wallpaper-").and_then(|n| n.strip_suffix(".png")) else {
        return false;
    };
    match stem.parse::<u128>() {
        Ok(written) => now.saturating_sub(written) >= LIVE_GRACE.as_millis(),
        Err(_) => true,
    }
}

#[cfg(target_os = "macos")]
fn set_os(path: &Path) -> Result<()> {
    set_macos(path.to_str().ok_or_else(|| anyhow!("non-utf8 live path"))?)
}

#[cfg(target_os = "linux")]
fn set_os(path: &Path) -> Result<()> {
    crate::wallpaper_linux::set(path.to_str().ok_or_else(|| anyhow!("non-utf8 live path"))?)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn set_os(path: &Path) -> Result<()> {
    let p = path.to_str().ok_or_else(|| anyhow!("non-utf8 path"))?;
    wallpaper::set_from_path(p).map_err(|e| anyhow!("set wallpaper: {}", e))?;
    let _ = wallpaper::set_mode(wallpaper::Mode::Crop);
    Ok(())
}

#[cfg(target_os = "macos")]
fn set_macos(path: &str) -> Result<()> {
    use std::process::Command;

    let escaped = path.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!(
        r#"ObjC.import("AppKit");
const url = $.NSURL.fileURLWithPath("{}");
const opts = $.NSMutableDictionary.alloc.init;
opts.setObjectForKey(3, "NSWorkspaceDesktopImageScalingKey");
opts.setObjectForKey(true, "NSWorkspaceDesktopImageAllowClippingKey");
const screens = $.NSScreen.screens;
for (let i = 0; i < screens.count; i++) {{
  $.NSWorkspace.sharedWorkspace.setDesktopImageURLForScreenOptionsError(
    url, screens.objectAtIndex(i), opts, $()
  );
}}
"ok""#,
        escaped
    );

    let out = Command::new("osascript").args(["-l", "JavaScript", "-e", &script]).output()?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(anyhow!("osascript failed: {}", err));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u128 = 1_794_207_184_769;

    #[test]
    fn a_replaced_copy_stays_until_the_grace_is_up() {
        let grace = LIVE_GRACE.as_millis();
        assert!(!is_stale_live_copy(&format!("wallpaper-{NOW}.png"), NOW));
        assert!(!is_stale_live_copy(&format!("wallpaper-{}.png", NOW - grace + 1), NOW));
        assert!(is_stale_live_copy(&format!("wallpaper-{}.png", NOW - grace), NOW));
    }

    #[test]
    fn a_copy_from_the_future_waits_and_others_are_left_alone() {
        assert!(!is_stale_live_copy(&format!("wallpaper-{}.png", NOW + 60_000), NOW));
        assert!(is_stale_live_copy("wallpaper-old.png", NOW));
        assert!(!is_stale_live_copy("daily", NOW));
        assert!(!is_stale_live_copy("wallpaper-1.jpg", NOW));
    }
}
