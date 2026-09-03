//! The system-tray icon and its menu — the app's primary surface, since there is
//! no Dock/taskbar entry.
//!
//! Menu items are held in `OnceLock`s because the labels are localized *after*
//! construction: the frontend pushes translations in via `update_labels` on i18n
//! init and on every language change, so Rust never owns a user-facing string.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use tauri::menu::{
    CheckMenuItem, CheckMenuItemBuilder, Menu, MenuBuilder, MenuItem, MenuItemBuilder,
    PredefinedMenuItem,
};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use crate::config::UpdateMode;
use crate::events::{FrontendEvent, Tab};
use crate::pipeline;
use crate::state::AppState;

pub const TRAY_ID: &str = "main";

static OPEN_ITEM: OnceLock<MenuItem<Wry>> = OnceLock::new();
static TOGGLE_ITEM: OnceLock<CheckMenuItem<Wry>> = OnceLock::new();
static REGEN_ITEM: OnceLock<MenuItem<Wry>> = OnceLock::new();
static QUIT_ITEM: OnceLock<MenuItem<Wry>> = OnceLock::new();

// "Update available" entry — built up front (so its label can be localized via
// update_labels) but only prepended to the menu once a new release is detected.
static MENU: OnceLock<Menu<Wry>> = OnceLock::new();
static UPDATE_ITEM: OnceLock<MenuItem<Wry>> = OnceLock::new();
static UPDATE_SEP: OnceLock<PredefinedMenuItem<Wry>> = OnceLock::new();
static UPDATE_SHOWN: AtomicBool = AtomicBool::new(false);

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let initial_daily = *app.state::<AppState>().update_mode.lock().unwrap() == UpdateMode::Daily;

    let open_item = MenuItemBuilder::with_id("open", "Open Settings").build(app)?;
    let toggle_item = CheckMenuItemBuilder::with_id("toggle_enabled", "Daily Updates")
        .checked(initial_daily)
        .build(app)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let regen_item = MenuItemBuilder::with_id("regen", "Regenerate Now").build(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItemBuilder::with_id("quit", "Quit InkCity").build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&open_item)
        .item(&toggle_item)
        .item(&sep1)
        .item(&regen_item)
        .item(&sep2)
        .item(&quit_item)
        .build()?;

    let update_item = MenuItemBuilder::with_id("update", "Update available").build(app)?;
    let update_sep = PredefinedMenuItem::separator(app)?;

    let _ = OPEN_ITEM.set(open_item);
    let _ = TOGGLE_ITEM.set(toggle_item);
    let _ = REGEN_ITEM.set(regen_item);
    let _ = QUIT_ITEM.set(quit_item);
    let _ = UPDATE_ITEM.set(update_item);
    let _ = UPDATE_SEP.set(update_sep);
    let _ = MENU.set(menu.clone());

    let mut builder = TrayIconBuilder::with_id(TRAY_ID).tooltip("InkCity").menu(&menu);

    // All icons are embedded at compile time (paths are relative to src-tauri/);
    // see the header comment in icons/tray-icon.svg for how they're regenerated.
    //
    // macOS menu bars want a monochrome template image, which the system tints for
    // the light/dark menu bar on its own. Windows does no such thing — it blits the
    // bitmap as-is — so the same glyph ships in two colours and tray_theme swaps
    // between them; the icon is set there rather than here to keep the choice in
    // one place. Everything else falls back to the full-colour app icon.
    #[cfg(target_os = "macos")]
    {
        builder = builder.icon(tauri::include_image!("icons/tray.png")).icon_as_template(true);
    }
    #[cfg(target_os = "windows")]
    {
        builder = builder.icon(crate::tray_theme::current_icon());
    }
    // Linux gets the full-colour app icon: appindicator hosts render the bitmap
    // as given (no template tinting like macOS) but sit on panels of any colour,
    // so a monochrome glyph would be the one thing guaranteed to disappear
    // somewhere. Embedded at compile time rather than read from
    // `default_window_icon()` — that returns an `Option`, and the previous
    // `ok_or_else(...)?` here would have turned a missing icon into a failed
    // `setup()`, i.e. an app that doesn't start at all, over a 32×32 png.
    #[cfg(target_os = "linux")]
    {
        builder = builder.icon(tauri::include_image!("icons/32x32.png"));
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let icon = app
            .default_window_icon()
            .ok_or_else(|| tauri::Error::AssetNotFound("default icon".into()))?
            .clone();
        builder = builder.icon(icon);
    }

    let _tray = builder
        .on_menu_event(|app, event| {
            let app = app.clone();
            match event.id().as_ref() {
                "open" => {
                    show_settings(&app);
                    // Land on City — the day-to-day view, and the frontend's own
                    // default on a fresh mount. Worth emitting anyway: the window is
                    // only hidden when closed, so without this it reopens on
                    // whatever tab it was left on. Deliberately not in
                    // `show_settings`, so the tray icon click and the
                    // relaunch/reopen paths keep the user where they were.
                    FrontendEvent::OpenTab(Tab::City).emit(&app);
                }
                "update" => {
                    // Short path: confirm and install in place via a native
                    // dialog — no need to open the settings window at all.
                    crate::updates::prompt_and_install(&app);
                }
                "toggle_enabled" => {
                    // Toggle the Daily rotation on/off. Off ⇒ Disable; from a
                    // Customized pin, "Daily Updates" switches to Daily.
                    let now_daily = {
                        let state = app.state::<AppState>();
                        let mut m = state.update_mode.lock().unwrap();
                        *m = if *m == UpdateMode::Daily {
                            UpdateMode::Disable
                        } else {
                            UpdateMode::Daily
                        };
                        *m == UpdateMode::Daily
                    };
                    sync_mode_to_tray(&app);
                    // Tray is the one path the frontend can't observe via its own
                    // command round-trip — the push is what keeps an open window in
                    // sync. Note this path does NOT persist the new mode, unlike
                    // `commands::set_update_mode`: a tray toggle is forgotten on
                    // restart.
                    app.state::<AppState>().mark_status_dirty();
                    if now_daily {
                        pipeline::spawn_apply(app);
                    }
                }
                "regen" => {
                    pipeline::spawn_force_regen(app);
                }
                "quit" => {
                    app.state::<AppState>().quitting.store(true, Ordering::Release);
                    app.exit(0);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button, button_state, .. } = event {
                if button == MouseButton::Left && button_state == MouseButtonState::Up {
                    show_settings(tray.app_handle());
                }
            }
        })
        .build(app)?;

    // Follow the taskbar for the rest of the session — the builder above only
    // picked the glyph that was right at startup.
    #[cfg(target_os = "windows")]
    crate::tray_theme::spawn_watcher(app.clone());

    Ok(())
}

pub fn show_settings(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

pub fn sync_mode_to_tray(app: &AppHandle) {
    let daily = *app.state::<AppState>().update_mode.lock().unwrap() == UpdateMode::Daily;
    if let Some(item) = TOGGLE_ITEM.get() {
        let _ = item.set_checked(daily);
    }
}

/// Reveal the "Update available" entry at the top of the tray menu. Idempotent:
/// only inserts on the first call so repeated detections don't stack entries.
pub fn show_update_available(_app: &AppHandle) {
    if UPDATE_SHOWN.swap(true, Ordering::AcqRel) {
        return;
    }
    let (Some(menu), Some(item), Some(sep)) = (MENU.get(), UPDATE_ITEM.get(), UPDATE_SEP.get())
    else {
        return;
    };
    // Prepend separator first, then the item, leaving [item, sep, ...rest].
    let _ = menu.prepend(sep);
    let _ = menu.prepend(item);
}

/// Remove the "Update available" entry. Idempotent: only acts if it was shown.
/// Called when a check finds we're already up to date, so the tray never offers
/// to install a version that no longer applies.
pub fn hide_update_available(_app: &AppHandle) {
    if !UPDATE_SHOWN.swap(false, Ordering::AcqRel) {
        return;
    }
    let (Some(menu), Some(item), Some(sep)) = (MENU.get(), UPDATE_ITEM.get(), UPDATE_SEP.get())
    else {
        return;
    };
    let _ = menu.remove(item);
    let _ = menu.remove(sep);
}

pub fn apply_hide_tray(app: &AppHandle, hide: bool) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_visible(!hide);
    }
}

/// Update the tray menu labels. Called by the frontend after i18n init and on
/// every language change so translations stay in JSON (single source of truth)
/// and Rust just renders whatever it's told.
pub fn update_labels(
    open_settings: &str,
    daily_updates: &str,
    regenerate_now: &str,
    quit: &str,
    update_available: &str,
) {
    if let Some(it) = OPEN_ITEM.get() {
        let _ = it.set_text(open_settings);
    }
    if let Some(it) = TOGGLE_ITEM.get() {
        let _ = it.set_text(daily_updates);
    }
    if let Some(it) = REGEN_ITEM.get() {
        let _ = it.set_text(regenerate_now);
    }
    if let Some(it) = QUIT_ITEM.get() {
        let _ = it.set_text(quit);
    }
    if let Some(it) = UPDATE_ITEM.get() {
        let _ = it.set_text(update_available);
    }
}
