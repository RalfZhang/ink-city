use anyhow::{anyhow, Result};
use std::path::{Path, PathBuf};

pub fn set(path: &Path) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        // Workaround: NSWorkspace.setDesktopImageURL caches by URL equality,
        // so setting to the same path twice (even after content change) is a
        // silent no-op. Copy the canonical PNG to a unique-suffix sibling
        // each time and set wallpaper to that copy.
        let unique = bump_live_path(path)?;
        std::fs::copy(path, &unique)?;
        let r = set_macos(unique.to_str().ok_or_else(|| anyhow!("non-utf8 live path"))?);
        if let Some(dir) = unique.parent() {
            cleanup_live_files(dir, &unique);
        }
        r
    }

    #[cfg(not(target_os = "macos"))]
    {
        let p = path.to_str().ok_or_else(|| anyhow!("non-utf8 path"))?;
        wallpaper::set_from_path(p).map_err(|e| anyhow!("set wallpaper: {}", e))?;
        let _ = wallpaper::set_mode(wallpaper::Mode::Crop);
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn bump_live_path(orig: &Path) -> Result<PathBuf> {
    let dir = orig
        .parent()
        .ok_or_else(|| anyhow!("png has no parent dir"))?;
    let stem = orig
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("wallpaper");
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    Ok(dir.join(format!("{}.live.{}.png", stem, ts)))
}

#[cfg(target_os = "macos")]
fn cleanup_live_files(dir: &Path, keep: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if p == *keep {
            continue;
        }
        let Some(name) = p.file_name().and_then(|n| n.to_str()) else { continue };
        if name.contains(".live.") && name.ends_with(".png") {
            let _ = std::fs::remove_file(&p);
        }
    }
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

    let out = Command::new("osascript")
        .args(["-l", "JavaScript", "-e", &script])
        .output()?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(anyhow!("osascript failed: {}", err));
    }
    Ok(())
}
