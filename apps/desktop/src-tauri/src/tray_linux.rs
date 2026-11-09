//! Linux-only: is there anywhere for the tray icon to actually appear?
//!
//! This matters more here than the equivalent question would on macOS or
//! Windows, because InkCity has no Dock or taskbar entry by design — the tray is
//! the whole UI surface. On Linux the tray is not part of the platform: Tauri
//! publishes a `StatusNotifierItem` over the session bus and something else has
//! to be watching for it. GNOME 45+ ships no watcher at all unless the user has
//! installed the AppIndicator extension, and the registration still *succeeds*
//! in that case — the item is published into the void. So an autostart launch
//! there would leave a running process with no window, no tray icon and no
//! taskbar entry: nothing to click, and no hint the app is running.
//!
//! `status_notifier_available` is the signal `lib.rs` uses to surface the
//! settings window anyway in that situation.
//!
//! Note two further Linux tray limitations that are handled by comments rather
//! than code, since there is nothing to fall back to: `TrayIconEvent` is never
//! emitted (so `tray.rs`'s left-click-opens-settings handler is inert, and the
//! menu's "Open Settings" item is the way in), and tooltips are unsupported.

use std::process::Command;

/// The well-known bus name a tray host claims. Named by KDE, but it's the
/// freedesktop `StatusNotifierItem` spec everyone implements — GNOME's
/// AppIndicator extension, Plasma, xfce4-statusnotifier-plugin, waybar, and so on.
const WATCHER: &str = "org.kde.StatusNotifierWatcher";

/// Whether some tray host is currently watching the session bus.
///
/// Deliberately optimistic on every inconclusive answer: `gdbus` missing tells us
/// nothing about the tray, and wrongly concluding "no tray" would pop the settings
/// window open on every login — far more annoying than the case this exists to
/// prevent.
pub fn status_notifier_available() -> bool {
    name_has_owner_gdbus().unwrap_or(true)
}

/// `gdbus call` prints the reply tuple, e.g. `(true,)`.
fn name_has_owner_gdbus() -> Option<bool> {
    let out = Command::new("gdbus")
        .args([
            "call",
            "--session",
            "--dest",
            "org.freedesktop.DBus",
            "--object-path",
            "/org/freedesktop/DBus",
            "--method",
            "org.freedesktop.DBus.NameHasOwner",
            WATCHER,
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_bool_reply(&String::from_utf8_lossy(&out.stdout))
}

/// The boolean in `gdbus`'s reply tuple, matched as a word. `None` for output
/// containing neither, which `status_notifier_available` reads as "inconclusive"
/// and not as "no tray".
fn parse_bool_reply(s: &str) -> Option<bool> {
    if s.contains("true") {
        Some(true)
    } else if s.contains("false") {
        Some(false)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_gdbus_tuple_form() {
        assert_eq!(parse_bool_reply("(true,)\n"), Some(true));
        assert_eq!(parse_bool_reply("(false,)\n"), Some(false));
    }

    #[test]
    fn unrecognized_output_is_inconclusive_rather_than_false() {
        assert_eq!(parse_bool_reply(""), None);
        assert_eq!(parse_bool_reply("Error: something went wrong\n"), None);
    }
}
