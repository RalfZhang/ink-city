//! Windows-only: keep the tray glyph readable when the taskbar flips light/dark.
//!
//! Unlike macOS — where a template image is tinted by the system and the app does
//! nothing — Windows blits the `HICON` verbatim. A monochrome glyph therefore needs
//! two rasters and a runtime swap.
//!
//! The signal is deliberately *not* Tauri's `WindowEvent::ThemeChanged`. Windows has
//! two independent theme switches (Settings → Personalization → Colors → Custom):
//! `SystemUsesLightTheme` governs the taskbar and notification area, while
//! `AppsUseLightTheme` governs app content. tao reads the latter, so flipping only
//! "Windows mode" — which is exactly what repaints the strip our icon sits on —
//! never fires a Tauri event. So we read `SystemUsesLightTheme` ourselves and watch
//! the key with `RegNotifyChangeKeyValue`.

use std::ffi::c_void;

use tauri::image::Image;
use tauri::AppHandle;
use windows_sys::Win32::Foundation::{ERROR_SUCCESS, HANDLE};
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegGetValueW, RegNotifyChangeKeyValue, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER,
    KEY_NOTIFY, KEY_QUERY_VALUE, REG_NOTIFY_CHANGE_LAST_SET, RRF_RT_REG_DWORD,
};

use crate::tray::TRAY_ID;

/// No event object: makes `RegNotifyChangeKeyValue` block instead of signalling.
const NULL_HANDLE: HANDLE = std::ptr::null_mut();

/// UTF-16, NUL-terminated — what the `*W` registry entry points expect.
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn personalize_subkey() -> Vec<u16> {
    wide(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")
}

/// Is the taskbar/notification area currently light?
///
/// Falls back to `true` when the value can't be read: Windows 11 ships in light
/// mode, and the value has existed since Windows 10 1809, so this only covers a
/// genuinely broken profile.
pub fn taskbar_is_light() -> bool {
    let subkey = personalize_subkey();
    let value = wide("SystemUsesLightTheme");
    let mut data: u32 = 1;
    let mut size = std::mem::size_of::<u32>() as u32;

    // SAFETY: all pointers are to live locals, and `size` is the true byte length
    // of `data`. RegGetValueW writes at most `size` bytes.
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_DWORD,
            std::ptr::null_mut(),
            &mut data as *mut u32 as *mut c_void,
            &mut size,
        )
    };

    if status != ERROR_SUCCESS {
        return true;
    }
    data != 0
}

/// Whichever glyph contrasts with the taskbar right now. Both are decoded at
/// compile time, so picking between them costs one registry read.
pub fn current_icon() -> Image<'static> {
    if taskbar_is_light() {
        tauri::include_image!("icons/tray-win-light.png")
    } else {
        tauri::include_image!("icons/tray-win-dark.png")
    }
}

/// Re-point an existing tray at the right glyph.
///
/// Must run on the main thread — the tray's `HWND` (and so `Shell_NotifyIcon`)
/// lives there.
pub fn apply(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_icon(Some(current_icon()));
    }
}

/// Watch the Personalize key and re-`apply` on every change.
///
/// `RegNotifyChangeKeyValue` is called synchronously (no event handle), so the
/// thread simply parks in the kernel until something under the key is written. It
/// fires for `AppsUseLightTheme` too, which is harmless: `apply` re-reads the value
/// we actually care about and hands the tray the same icon it already has.
pub fn spawn_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        let subkey = personalize_subkey();
        let mut hkey: HKEY = std::ptr::null_mut();

        // SAFETY: `subkey` outlives the call; `hkey` is a live local.
        let status = unsafe {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                subkey.as_ptr(),
                0,
                KEY_NOTIFY | KEY_QUERY_VALUE,
                &mut hkey,
            )
        };
        if status != ERROR_SUCCESS {
            log::warn!(
                "tray theme: cannot open Personalize key ({status}); icon won't follow the taskbar"
            );
            return;
        }

        // Re-sync before parking. The tray was built from a read taken back in
        // `setup`, and the synchronous form of RegNotifyChangeKeyValue registers
        // and blocks in the same call — so there is no way to be watching *before*
        // that first read. Catching up here narrows the blind spot to the gap
        // between this read and the call below, instead of leaving it open for as
        // long as tray construction takes.
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || apply(&handle));

        loop {
            // SAFETY: `hkey` is open for KEY_NOTIFY. A null event handle with
            // fAsynchronous = FALSE means "block until the key changes".
            let status = unsafe {
                RegNotifyChangeKeyValue(hkey, 0, REG_NOTIFY_CHANGE_LAST_SET, NULL_HANDLE, 0)
            };
            if status != ERROR_SUCCESS {
                log::warn!("tray theme: registry watch failed ({status}); giving up");
                break;
            }
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || apply(&handle));
        }

        // Only reachable on the error path above: the healthy thread parks in the
        // loop until the process exits, and the kernel reclaims the key then.
        // SAFETY: `hkey` was opened above and is not used again.
        unsafe { RegCloseKey(hkey) };
    });
}
