use std::sync::atomic::Ordering;
use std::sync::OnceLock;

use tauri::menu::{CheckMenuItem, CheckMenuItemBuilder, MenuBuilder, MenuItem, MenuItemBuilder, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use crate::city;
use crate::pipeline;
use crate::state::AppState;

pub const TRAY_ID: &str = "main";

static OPEN_ITEM: OnceLock<MenuItem<Wry>> = OnceLock::new();
static TOGGLE_ITEM: OnceLock<CheckMenuItem<Wry>> = OnceLock::new();
static REGEN_ITEM: OnceLock<MenuItem<Wry>> = OnceLock::new();
static QUIT_ITEM: OnceLock<MenuItem<Wry>> = OnceLock::new();

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let initial_enabled = app.state::<AppState>().enabled.load(Ordering::Acquire);

    let open_item = MenuItemBuilder::with_id("open", "Open Settings").build(app)?;
    let toggle_item = CheckMenuItemBuilder::with_id("toggle_enabled", "Daily Updates")
        .checked(initial_enabled)
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

    let _ = OPEN_ITEM.set(open_item);
    let _ = TOGGLE_ITEM.set(toggle_item);
    let _ = REGEN_ITEM.set(regen_item);
    let _ = QUIT_ITEM.set(quit_item);

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("InkCity")
        .menu(&menu);

    // macOS menu bars want a monochrome template image that auto-tints for
    // light/dark; other platforms use the full-color app icon. The template is
    // embedded at compile time (path is relative to src-tauri/). Regenerate
    // icons/tray.png from icons/tray-icon.svg:
    //   npx tauri icon src-tauri/icons/tray-icon.svg -o /tmp/tray-out
    //   sips -z 44 44 /tmp/tray-out/128x128.png --out src-tauri/icons/tray.png
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .icon(tauri::include_image!("icons/tray.png"))
            .icon_as_template(true);
    }
    #[cfg(not(target_os = "macos"))]
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
                "open" => show_settings(&app),
                "toggle_enabled" => {
                    let state = app.state::<AppState>();
                    let new_val = !state.enabled.load(Ordering::Acquire);
                    state.enabled.store(new_val, Ordering::Release);
                    sync_enabled_to_tray(&app);
                }
                "regen" => {
                    tauri::async_runtime::spawn(async move {
                        let date = city::today();
                        if let Err(e) = pipeline::run_for_date(app, date).await {
                            eprintln!("[tray] regenerate failed: {}", e);
                        }
                    });
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

    Ok(())
}

pub fn show_settings(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

pub fn sync_enabled_to_tray(app: &AppHandle) {
    let on = app.state::<AppState>().enabled.load(Ordering::Acquire);
    if let Some(item) = TOGGLE_ITEM.get() {
        let _ = item.set_checked(on);
    }
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
}
