use std::sync::atomic::Ordering;
use std::sync::OnceLock;

use tauri::menu::{CheckMenuItem, CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use crate::city;
use crate::pipeline;
use crate::state::AppState;

pub const TRAY_ID: &str = "main";

static TOGGLE_ITEM: OnceLock<CheckMenuItem<Wry>> = OnceLock::new();

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

    let _ = TOGGLE_ITEM.set(toggle_item);

    let icon = app
        .default_window_icon()
        .ok_or_else(|| tauri::Error::AssetNotFound("default icon".into()))?
        .clone();

    let _tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("InkCity")
        .menu(&menu)
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
