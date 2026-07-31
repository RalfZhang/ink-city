//! App entry point and wiring: plugin registration, window setup, the per-OS
//! chrome tweaks, and the two background tasks (`scheduler::spawn` and the
//! status-emitter loop at the end of `setup`).
//!
//! The modules, roughly outermost-in:
//!
//!   - `commands` / `events` — the two halves of the frontend boundary: invokable
//!     commands in, `FrontendEvent`s out. `state` holds what both read.
//!   - `scheduler` — the 60s poll that reconciles the wallpaper; drives `pipeline`.
//!   - `pipeline` — resolve what to render → get its OSM → draw it in the hidden
//!     renderer window → `wallpaper_set` it. The core of the app.
//!   - `cdn` / `github_mirror` / `osm_sidecar` — where OSM data comes from, in
//!     fallback order. `cities_update` refreshes the bundled city list the same way.
//!   - `city` / `bbox` — ports of `src/core/{city,bbox}.ts`; keep them in sync.
//!   - `config` (persisted) vs `state` (live). `tray`, `updates` — the windowless
//!     surfaces, whose user-facing strings are pushed in from the frontend's i18n.
mod bbox;
mod cdn;
mod cities_update;
mod city;
mod commands;
mod config;
mod events;
mod github_mirror;
mod osm_sidecar;
mod pipeline;
mod scheduler;
mod state;
mod tray;
mod updates;
mod wallpaper_set;

use std::sync::atomic::Ordering;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;

use crate::config::ThemeMode;
use crate::state::AppState;

/// CLI flag injected into the autostart (login) launch command. Its presence
/// means "started by the OS at login" → stay silent in the background; its
/// absence means the user opened the app, so we surface the settings window.
const AUTOSTART_FLAG: &str = "--autostart";

fn launched_by_autostart() -> bool {
    args_have_autostart_flag(std::env::args())
}

fn args_have_autostart_flag(args: impl IntoIterator<Item = String>) -> bool {
    args.into_iter().any(|a| a == AUTOSTART_FLAG)
}

/// Ask Windows to relaunch us with `--autostart` if it ever restarts this app
/// on our behalf (e.g. "Restart apps after sign-in" following a Windows
/// Update reboot). That relaunch is otherwise indistinguishable from a user
/// double-click — it carries no CLI args of our choosing — which would make
/// `launched_by_autostart()` wrongly conclude the window should be shown.
/// Must be (re-)registered on every launch; Windows does not persist it.
#[cfg(target_os = "windows")]
fn register_restart_with_autostart_flag() {
    use windows_sys::Win32::System::Recovery::RegisterApplicationRestart;

    let cmdline: Vec<u16> = AUTOSTART_FLAG.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        RegisterApplicationRestart(cmdline.as_ptr(), 0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flag_present_when_launched_via_autostart() {
        let argv = vec!["/path/to/InkCity".to_string(), AUTOSTART_FLAG.to_string()];
        assert!(args_have_autostart_flag(argv));
    }

    #[test]
    fn flag_absent_on_a_plain_user_launch() {
        let argv = vec!["/path/to/InkCity".to_string()];
        assert!(!args_have_autostart_flag(argv));
    }

    #[test]
    fn flag_check_ignores_other_args() {
        let argv = vec![
            "/path/to/InkCity".to_string(),
            "--some-other-flag".to_string(),
        ];
        assert!(!args_have_autostart_flag(argv));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // single-instance must be the first plugin: a second launch (e.g. the
        // user reopening from Applications while we're already running) is
        // funneled into this callback instead of starting a new process, and we
        // surface the existing settings window. Except when that second launch
        // is itself an autostart relaunch (e.g. an OS session-resume feature
        // racing our own LaunchAgent/Run-key entry at login) — that should stay
        // just as silent as a first-instance autostart launch.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if !args_have_autostart_flag(argv) {
                tray::show_settings(app);
            }
        }))
        // Registered early so setup()/plugin init issues are captured too.
        // Persists to the OS log dir (`commands::open_log_dir` surfaces the
        // exact per-platform path to the user) so a user hitting a bug can
        // find and attach it, instead of the previous
        // eprintln!-to-a-console-nobody-sees. Capped and rotated (2 MiB × 3
        // files) so it never grows unbounded — this app's log volume is low
        // (daily regen, occasional network retries), so that comfortably
        // covers weeks of history.
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .max_file_size(2 * 1024 * 1024)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(3))
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![AUTOSTART_FLAG]),
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let handle = app.handle();

            // No Dock icon, ever (macOS). Accessory keeps the app alive as a
            // menu-bar app with no Dock presence; the settings window can still
            // be shown and focused. Set as early as possible to minimize any
            // Dock-icon flash on launch.
            #[cfg(target_os = "macos")]
            let _ = handle.set_activation_policy(tauri::ActivationPolicy::Accessory);

            #[cfg(target_os = "windows")]
            register_restart_with_autostart_flag();

            // Load persisted config and seed AppState from it.
            let first_run = config::is_first_run(handle);
            let cfg = config::load(handle);
            let hide_tray_initial = cfg.hide_tray;
            // Apply the persisted proxy to the shared HTTP client before any
            // fetch runs (the sidecar reads it from env at spawn — see
            // osm_sidecar). Empty/disabled ⇒ direct connection.
            if cfg.proxy_enabled && !cfg.proxy_url.trim().is_empty() {
                github_mirror::set_proxy(Some(cfg.proxy_url.clone()));
            }
            handle.manage(AppState::from_config(&cfg));

            // First-launch default: turn on launch-at-login once. Autostart
            // state lives in the OS (LaunchAgent plist / HKCU Run key), not in
            // our config, so we gate on a dedicated first-run sentinel rather
            // than config.json — that keeps config.json absent for users who
            // never change a setting (preserving future Config::default()
            // changes for them). A user who later switches it off in the
            // General tab stays off; the user always keeps full control.
            if first_run {
                use tauri_plugin_autostart::ManagerExt;
                let _ = handle.autolaunch().enable();
                let _ = config::mark_initialized(handle);
            }

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
            .skip_taskbar(true)
            .title("InkCity Renderer")
            .build()?;

            // Close button on settings window hides instead of quitting.
            // Also: when in System theme mode, re-render wallpaper on system theme changes.
            if let Some(main) = handle.get_webview_window("main") {
                #[cfg(target_os = "macos")]
                {
                    use objc2::{msg_send, runtime::AnyObject};
                    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
                    let _ = apply_vibrancy(&main, NSVisualEffectMaterial::Sidebar, None, None);

                    // Stop the green traffic-light button from entering
                    // Fullscreen Mode. Tauri's default collection behavior is
                    // 0, which still leaves the window fullscreen-capable
                    // because the app itself is fullscreen-capable.  Setting
                    // `NSWindowCollectionBehaviorFullScreenNone` (1<<9)
                    // explicitly disables fullscreen for this window, which
                    // switches the green button to its `zoom:` (➕) variant.
                    // `zoom:` then respects our maxWidth=732 constraint and
                    // only grows the window vertically; a second click toggles
                    // back to the previous frame.
                    if let Ok(ptr) = main.ns_window() {
                        let ns_window = ptr as *mut AnyObject;
                        unsafe {
                            let current: usize = msg_send![ns_window, collectionBehavior];
                            let new_behavior = (current & !(1usize << 7)) | (1usize << 9);
                            let _: () = msg_send![ns_window, setCollectionBehavior: new_behavior];

                            // Opt this window out of macOS's automatic window
                            // restoration ("Reopen windows when logging back
                            // in"). That system feature can relaunch us at the
                            // next login independent of (and in addition to)
                            // our own LaunchAgent, with no way for us to tell
                            // that relaunch apart from a real user launch —
                            // and it would restore the window to whatever
                            // visibility it had at logout. We don't rely on
                            // window-restoration state for anything, so
                            // disabling it is free and closes that gap.
                            let _: () = msg_send![ns_window, setRestorable: false];
                        }
                    }
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
                        // Push the (possibly changed) effectiveTheme so the Style
                        // tab's active-palette highlight updates even if the
                        // regen above is a no-op or skipped.
                        app_handle.state::<AppState>().mark_status_dirty();
                    }
                    _ => {}
                });

                // The window starts hidden (config `visible: false`). Surface it
                // only when the user launched the app; an autostart (login)
                // launch stays silent in the background.
                if !launched_by_autostart() {
                    let _ = main.show();
                    let _ = main.set_focus();
                }
            }

            tray::setup(handle)?;
            tray::apply_hide_tray(handle, hide_tray_initial);

            // Restore a previously-detected "update available" affordance (tray
            // entry + General-tab state) without hitting the network. Guarded by
            // a version comparison so an out-of-band upgrade clears it instead.
            updates::restore_pending(handle);

            // Settle notification permission up front so the first "update
            // available" notification isn't lost racing the OS prompt. macOS
            // prompts only on the first ever launch; later launches are no-ops.
            updates::ensure_permission(handle);

            scheduler::spawn(handle.clone());

            // Status-emitter task: the single point that pushes state to the
            // frontend. Mutation sites only call `mark_status_dirty()`; this task
            // builds the snapshot once and emits it. `notify_one`'s stored permit
            // means the trailing state is never lost even if signals arrive
            // mid-build. No window gate: a closed settings window is only hidden
            // (its webview stays alive and subscribed), so emitting keeps it
            // current for an instant reopen.
            let emit_handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                let dirty = emit_handle.state::<AppState>().status_dirty.clone();
                loop {
                    dirty.notified().await;
                    let status = commands::build_status(&emit_handle).await;
                    crate::events::FrontendEvent::StatusChanged(status).emit(&emit_handle);
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_status,
            commands::set_update_mode,
            commands::apply_custom_city,
            commands::search_cities,
            commands::set_hide_tray,
            commands::set_update_check,
            commands::set_auto_update,
            commands::check_for_update,
            commands::install_update,
            commands::set_update_strings,
            commands::apply_style_settings,
            commands::apply_lab_settings,
            commands::set_bypass_cache,
            commands::set_dev_mode,
            commands::apply_proxy_settings,
            commands::get_color_defaults,
            commands::regenerate_now,
            commands::renderer_ready,
            commands::submit_render_result,
            commands::quit_app,
            commands::hide_window,
            commands::update_tray_labels,
            commands::open_log_dir,
            commands::preview_city,
            commands::clean_cache,
            commands::open_preview_image,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, _event| {
            // Reopening an already-running app (double-clicking it in Finder, or
            // any other reopen trigger) surfaces the settings window — the only
            // way back in when both the Dock icon and the tray icon are hidden.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                tray::show_settings(_app_handle);
            }
        });
}
