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
        let mut last_housekeeping: Option<NaiveDate> = None;
        loop {
            let today = city::today();

            // Housekeeping (remote cities list + GitHub release check) is daily,
            // not every tick — gate it on the calendar date rolling over so the
            // 60s poll doesn't hammer the network. Both have their own internal
            // freshness gates too (ETag / cadence), so this stays cheap.
            if last_housekeeping != Some(today) {
                cities_update::spawn_check(app.clone());
                updates::spawn_check(app.clone());
                last_housekeeping = Some(today);
            }

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
