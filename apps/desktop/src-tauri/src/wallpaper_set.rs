//! Handing a rendered PNG to the OS as the desktop wallpaper — the one module that
//! talks to the platform's desktop APIs: osascript/JXA on macOS, the `wallpaper`
//! crate on Windows, and `wallpaper_linux`'s per-desktop dispatch on Linux (see
//! that module for why the crate isn't used there).

use anyhow::{anyhow, Result};
use std::path::{Path, PathBuf};

/// Apply `src` as the desktop wallpaper. Copies it to a freshly-timestamped
/// `wallpaper-<ts>.png` in `live_dir` (the `wallpaper/` cache root) and points
/// the OS at that copy, then removes the older `wallpaper-*.png` siblings.
///
/// The fresh filename on every call is what makes the change reliably take on
/// macOS — NSWorkspace.setDesktopImageURL caches by URL equality, so re-setting
/// the same path (even after the content changed) is a silent no-op — and it's
/// harmless on Windows, which copies the image into its own store on set, so the
/// source file can be replaced next time without disturbing the live desktop. On
/// Linux it's load-bearing again for the same reason as macOS: GNOME and Plasma
/// both key their wallpaper cache on the path, so a re-set of an unchanged
/// filename shows the previous image.
pub fn set(src: &Path, live_dir: &Path) -> Result<()> {
    std::fs::create_dir_all(live_dir)?;
    let live = fresh_live_path(live_dir);
    std::fs::copy(src, &live)?;
    let r = set_os(&live);
    cleanup_live_files(live_dir, &live);
    r
}

fn fresh_live_path(dir: &Path) -> PathBuf {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    dir.join(format!("wallpaper-{ts}.png"))
}

/// Remove every `wallpaper-*.png` in `dir` except the one we just set, so the
/// live copies don't pile up.
fn cleanup_live_files(dir: &Path, keep: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if p == *keep {
            continue;
        }
        let Some(name) = p.file_name().and_then(|n| n.to_str()) else { continue };
        if name.starts_with("wallpaper-") && name.ends_with(".png") {
            let _ = std::fs::remove_file(&p);
        }
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
