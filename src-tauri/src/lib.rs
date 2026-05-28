mod bbox;
mod cities_update;
mod city;
mod commands;
mod config;
mod overpass;
mod pipeline;
mod scheduler;
mod state;
mod tray;
mod wallpaper_set;

use std::sync::atomic::Ordering;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;

use crate::config::ThemeMode;
use crate::state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .setup(|app| {
            let handle = app.handle();

            // Load persisted config and seed AppState from it.
            let cfg = config::load(handle);
            let hide_tray_initial = cfg.hide_tray;
            handle.manage(AppState::from_config(&cfg));

            // Initialize the cities list (cache → bundled fallback) before the
            // scheduler picks today's city.
            city::initialize(handle);

            // Hidden renderer window — built up front so it's ready for the first run.
            let _ = WebviewWindowBuilder::new(
                handle,
                "renderer",
                WebviewUrl::App("render.html".into()),
            )
            .visible(false)
            .title("InkCity Renderer")
            .build()?;

            // Close button on settings window hides instead of quitting.
            // Also: when in System theme mode, re-render wallpaper on system theme changes.
            if let Some(main) = handle.get_webview_window("main") {
                #[cfg(target_os = "macos")]
                {
                    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
                    let _ = apply_vibrancy(&main, NSVisualEffectMaterial::Sidebar, None, None);
                }
                #[cfg(target_os = "windows")]
                {
                    use window_vibrancy::{apply_mica, apply_acrylic};
                    // Prefer Mica (Win11). Fall back to Acrylic if Mica is unsupported (Win10).
                    if apply_mica(&main, None).is_err() {
                        let _ = apply_acrylic(&main, None);
                    }
                }

                let app_handle = handle.clone();
                let main_clone = main.clone();
                main.on_window_event(move |event| match event {
                    WindowEvent::CloseRequested { api, .. } => {
                        let quitting =
                            app_handle.state::<AppState>().quitting.load(Ordering::Acquire);
                        if !quitting {
                            api.prevent_close();
                            let _ = main_clone.hide();
                        }
                    }
                    WindowEvent::ThemeChanged(_) => {
                        let mode = *app_handle.state::<AppState>().theme.lock().unwrap();
                        if mode == ThemeMode::System {
                            pipeline::spawn_force_regen(app_handle.clone());
                        }
                    }
                    _ => {}
                });
            }

            tray::setup(handle)?;
            tray::apply_hide_tray(handle, hide_tray_initial);

            scheduler::spawn(handle.clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_status,
            commands::set_enabled,
            commands::set_hide_tray,
            commands::apply_style_settings,
            commands::get_color_defaults,
            commands::regenerate_now,
            commands::renderer_ready,
            commands::submit_render_result,
            commands::quit_app,
            commands::hide_window,
            commands::update_tray_labels,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
