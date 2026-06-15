use std::sync::atomic::Ordering;
use std::time::Duration;

use chrono::NaiveDate;
use tauri::{AppHandle, Manager};

use crate::cities_update;
use crate::city;
use crate::pipeline;
use crate::state::AppState;
use crate::updates;

/// How often the scheduler wakes to reconcile the wallpaper. A short poll
/// (rather than one long sleep until midnight) is what makes every wake path
/// robust: the monotonic timer barely advances while the machine is asleep, so
/// after boot / wake-from-sleep / unlock we re-check within ~POLL_SECS and
/// repaint if the date or system theme has moved on. Each tick is a cheap
/// no-op when nothing has changed (see `reconcile`).
const POLL_SECS: u64 = 60;

pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Calendar date the cities-list refresh last fired on. It's ETag-gated
        // and network-light, and there's nothing to retry within a day, so a
        // single shot when the date rolls over is plenty.
        let mut cities_checked: Option<NaiveDate> = None;
        loop {
            let today = city::today();

            if cities_checked != Some(today) {
                cities_update::spawn_check(app.clone());
                cities_checked = Some(today);
            }

            // The update check has its own persisted cadence gate, so we run it
            // every tick rather than once per day. That's deliberately not a
            // calendar gate: it lets the check (1) retry when it can't complete —
            // e.g. the poll races ahead of the Wi-Fi reconnect on wake-from-sleep
            // — instead of burning the day's only attempt, and (2) fire the
            // moment the cadence elapses rather than only at the next rollover.
            // It's a cheap no-op (no network) whenever nothing is due.
            updates::run_scheduled_check(&app).await;

            reconcile(&app).await;
            tokio::time::sleep(Duration::from_secs(POLL_SECS)).await;
        }
    });
}

/// Ensure the desktop wallpaper matches today's city rendered in the current
/// effective theme. Skips all work when `last_applied` already records that
/// exact (date, theme) — so the steady-state poll is just two lock reads.
async fn reconcile(app: &AppHandle) {
    let enabled = app.state::<AppState>().enabled.load(Ordering::Acquire);
    if !enabled {
        return;
    }
    let date = city::today();
    let theme = pipeline::effective_theme(app);
    if *app.state::<AppState>().last_applied.lock().unwrap() == Some((date, theme)) {
        return;
    }
    if let Err(e) = pipeline::run_for_date(app.clone(), date).await {
        eprintln!("[scheduler] pipeline failed for {}: {}", date, e);
    }
}
