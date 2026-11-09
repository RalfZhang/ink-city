//! Writing a file whole or not at all.
//!
//! What the app writes is read back on its own schedule — the map cache by the
//! window the moment `Status::map_ready` says it's there, the save and the config
//! at the next launch — so a write cut short by a quit, a crash or a full disk must
//! never leave half a file where a whole one is expected.

use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Write `bytes` to `path` through a sibling temp file (`temp_path`) and a rename,
/// so a write cut short leaves the old file, or none, rather than half of the new
/// one. Creates the parent directory: writers own creation.
///
/// Windows refuses to replace a file another process holds open without sharing
/// delete — an indexer or antivirus scanner looking at it. Then the file is written
/// in place: the atomicity is lost, the write is kept, which every caller would
/// rather.
pub fn write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = temp_path(path);
    if let Err(e) = fs::write(&tmp, bytes) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    if let Err(e) = fs::rename(&tmp, path) {
        log::warn!("[fs] replacing {} failed ({e}); writing in place", path.display());
        let _ = fs::remove_file(&tmp);
        fs::write(path, bytes)?;
    }
    Ok(())
}

/// The temp file `write` goes through for `path`: its name plus `.tmp`, beside it.
/// One left behind means a write was cut short; nothing reads it.
pub fn temp_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().map(OsString::from).unwrap_or_default();
    name.push(".tmp");
    path.with_file_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_the_file_and_leaves_no_temp_behind() {
        let dir = std::env::temp_dir().join(format!("inkcity-atomic-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let path = dir.join("nested").join("data.json");
        write(&path, b"first").unwrap();
        write(&path, b"second").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"second");
        assert!(!temp_path(&path).exists());
        assert_eq!(temp_path(&path).file_name().unwrap(), "data.json.tmp");
        let _ = fs::remove_dir_all(&dir);
    }
}
