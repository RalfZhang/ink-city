//! The system-tray icon and its menu — the app's primary surface, since there is
//! no Dock/taskbar entry.
//!
//! Menu items are held in `OnceLock`s because the labels are localized *after*
//! construction: the frontend pushes translations in via `update_labels` on i18n
//! init and on every language change, so Rust never owns a user-facing string.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use tauri::menu::{
    CheckMenuItem, CheckMenuItemBuilder, Menu, MenuBuilder, MenuItem, MenuItemBuilder,
    PredefinedMenuItem,
};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use crate::city;
use crate::commands::{self, Status};
use crate::config::UpdateMode;
use crate::events::{FrontendEvent, View};
use crate::guess_store;
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

// The "open" entry reads "Open Game" instead of "Open Settings" while today's
// guess-the-country game can be played. Both labels arrive from the frontend
// (`update_labels`); empty until then, which reads as the English fallbacks.
static OPEN_LABELS: Mutex<(String, String)> = Mutex::new((String::new(), String::new()));
static GAME_OPEN: AtomicBool = AtomicBool::new(false);

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let syncing = app.state::<AppState>().sync_wallpaper.load(Ordering::Acquire);

    let open_item = MenuItemBuilder::with_id("open", "Open Settings").build(app)?;
    let toggle_item = CheckMenuItemBuilder::with_id("toggle_sync", "Sync to Wallpaper")
        .checked(syncing)
        .build(app)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    // Regenerating means drawing the wallpaper again, which only syncing does.
    let regen_item = MenuItemBuilder::with_id("regen", "Regenerate Now").enabled(syncing).build(app)?;
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

    // All icons are embedded at compile time (paths are relative to apps/desktop/src-tauri/);
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

    let _tray = builder
        .on_menu_event(|app, event| {
            let app = app.clone();
            match event.id().as_ref() {
                "open" => {
                    show_settings(&app);
                    // Where the label said: the game on the home, or the settings
                    // sheet. Deliberately not in `show_settings`, so the tray icon
                    // click and the relaunch/reopen paths keep the user where they
                    // were.
                    let view = if GAME_OPEN.load(Ordering::Acquire) { View::Home } else { View::Settings };
                    FrontendEvent::OpenView(view).emit(&app);
                }
                "update" => {
                    // Short path: confirm and install in place via a native
                    // dialog — no need to open the settings window at all.
                    crate::updates::prompt_and_install(&app);
                }
                "toggle_sync" => {
                    // The same switch as the home's box, persisted the same way;
                    // the status push it sends keeps an open window in step.
                    let on = !app.state::<AppState>().sync_wallpaper.load(Ordering::Acquire);
                    if let Err(e) = commands::set_sync(&app, on) {
                        log::error!("[tray] couldn't switch syncing: {e}");
                        // The menu ticked itself on the click: put it back as it is.
                        sync_sync_to_tray(&app);
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
        crate::events::FrontendEvent::WindowShown.emit(app);
    }
}

/// Point the tray's "open" entry at the game while there's one to play: "Open Game"
/// exactly when the home's game would take a guess (`guess_store::is_playing` —
/// Daily mode, today neither over nor skipped, its city known and its map to hand
/// for the window), "Open Settings" otherwise — which opens the settings sheet.
///
/// Called with every status push (`lib.rs`'s emitter), and read off that `status`,
/// so the tray and the window agree on the mode, the city and whether it's painted.
/// Every input already marks status dirty when it moves: a guess or the "Daily
/// guess" switch (`commands::guess_store_write`), the mode (`set_update_mode`), the
/// midnight rollover (`scheduler`), and a run resolving the city and caching its map
/// (`pipeline::run_now`). Only touches the menu when the answer flips.
pub fn sync_open_item(app: &AppHandle, status: &Status) {
    let open = status.update_mode == UpdateMode::Daily
        && guess_store::is_playing(
            &app.state::<AppState>().guess_view.lock().unwrap(),
            city::today(),
            status.city.as_ref(),
            status.map_ready,
        );
    if GAME_OPEN.swap(open, Ordering::AcqRel) != open {
        apply_open_label();
    }
}

fn apply_open_label() {
    let Some(item) = OPEN_ITEM.get() else { return };
    let labels = OPEN_LABELS.lock().unwrap();
    let text = match (GAME_OPEN.load(Ordering::Acquire), labels.0.as_str(), labels.1.as_str()) {
        (true, _, "") => "Open Game",
        (true, _, game) => game,
        (false, "", _) => "Open Settings",
        (false, settings, _) => settings,
    };
    let _ = item.set_text(text);
}

/// Mirror the sync switch onto the tray: its check mark, and Regenerate, which
/// only means something while syncing.
pub fn sync_sync_to_tray(app: &AppHandle) {
    let on = app.state::<AppState>().sync_wallpaper.load(Ordering::Acquire);
    if let Some(item) = TOGGLE_ITEM.get() {
        let _ = item.set_checked(on);
    }
    if let Some(item) = REGEN_ITEM.get() {
        let _ = item.set_enabled(on);
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
    open_game: &str,
    sync_wallpaper: &str,
    regenerate_now: &str,
    quit: &str,
    update_available: &str,
) {
    *OPEN_LABELS.lock().unwrap() = (open_settings.to_string(), open_game.to_string());
    apply_open_label();
    if let Some(it) = TOGGLE_ITEM.get() {
        let _ = it.set_text(sync_wallpaper);
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
