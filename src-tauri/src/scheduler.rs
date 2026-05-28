use std::sync::atomic::Ordering;
use std::time::Duration;

use chrono::{Local, NaiveTime};
use tauri::{AppHandle, Manager};

use crate::cities_update;
use crate::city;
use crate::pipeline;
use crate::state::AppState;

pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            // Refresh the remote cities list (no-op when up to date thanks to
            // ETag). Runs on every tick regardless of the daily-update toggle —
            // the toggle gates wallpaper changes, not data freshness.
            cities_update::spawn_check(app.clone());

            run_if_enabled(&app).await;
            let wait = secs_until_next_midnight();
            tokio::time::sleep(Duration::from_secs(wait)).await;
        }
    });
}

async fn run_if_enabled(app: &AppHandle) {
    let enabled = app.state::<AppState>().enabled.load(Ordering::Acquire);
    if !enabled {
        return;
    }
    let date = city::today();
    if let Err(e) = pipeline::run_for_date(app.clone(), date).await {
        eprintln!("[scheduler] pipeline failed for {}: {}", date, e);
    }
}

fn secs_until_next_midnight() -> u64 {
    let now = Local::now();
    let next = (now + chrono::Duration::days(1))
        .with_time(NaiveTime::from_hms_opt(0, 0, 5).unwrap())
        .single()
        .unwrap_or_else(|| now + chrono::Duration::seconds(60));
    (next - now).num_seconds().max(60) as u64
}
