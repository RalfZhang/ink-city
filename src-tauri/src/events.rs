//! The single definition point for every backend→frontend event sent to the
//! main settings window. One tagged enum collects the event names (each string
//! appears exactly once) and the payload type for each, so adding an event is a
//! new variant the `match` arms force you to handle — the Rust analogue of a
//! Redux action-types file, with payload types locked in too.
//!
//! Note: `render-request` (the internal render protocol emitted to the hidden
//! renderer window in `pipeline.rs`) is deliberately NOT modeled here — it is
//! not a UI state event and targets a different window.

use tauri::{AppHandle, Emitter};

use crate::commands::Status;

pub enum FrontendEvent {
    /// Full status snapshot. Pushed by the status-emitter task after any
    /// `mark_status_dirty()`. This is THE state channel that replaced polling.
    StatusChanged(Status),
    /// Render pipeline started. An edge event (deliberately separate from the
    /// coalesced `StatusChanged`) driving the spinner / Style save-button.
    PipelineStart,
    /// Render pipeline finished.
    PipelineEnd,
    /// Ask the frontend to jump to a tab. Reserved: the frontend listens for
    /// `open-tab`, but no backend path emits it today (the tray's "update
    /// available" entry installs in place instead). Kept here so the registry
    /// stays complete and a future nav trigger is a one-line `.emit()`.
    #[allow(dead_code)]
    OpenTab(String),
}

impl FrontendEvent {
    /// The event name the frontend listens on. Centralized here so a typo can't
    /// silently split a channel across emit and listen sides.
    pub fn name(&self) -> &'static str {
        match self {
            Self::StatusChanged(_) => "status:changed",
            Self::PipelineStart => "pipeline:start",
            Self::PipelineEnd => "pipeline:end",
            Self::OpenTab(_) => "open-tab",
        }
    }

    /// The one place that actually calls `app.emit`. Emitting to a hidden (not
    /// destroyed) webview is harmless, so there is no window gate.
    pub fn emit(self, app: &AppHandle) {
        let name = self.name();
        let result = match self {
            Self::StatusChanged(s) => app.emit(name, s),
            Self::PipelineStart => app.emit(name, ()),
            Self::PipelineEnd => app.emit(name, ()),
            Self::OpenTab(tab) => app.emit(name, tab),
        };
        if let Err(e) = result {
            log::warn!("[events] emit {name} failed: {e}");
        }
    }
}
