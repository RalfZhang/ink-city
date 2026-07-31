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

/// The tabs `FrontendEvent::OpenTab` can target. An enum rather than a bare string
/// because the frontend receives this as a `TabId` (see `src/App.tsx`) and switches
/// to it: a value that isn't one of those ids would strand the Tabs component on a
/// tab with no trigger and no content. Add an arm when a new tab needs targeting.
pub enum Tab {
    City,
}

impl Tab {
    /// The `TabId` string the frontend matches on.
    fn id(&self) -> &'static str {
        match self {
            Self::City => "city",
        }
    }
}

pub enum FrontendEvent {
    /// Full status snapshot. Pushed by the status-emitter task after any
    /// `mark_status_dirty()`. THE state channel; the frontend does not poll.
    StatusChanged(Status),
    /// Render pipeline started. An edge event (deliberately separate from the
    /// coalesced `StatusChanged`) driving the spinner / Style save-button.
    PipelineStart,
    /// Render pipeline finished.
    PipelineEnd,
    /// Ask the frontend to switch to a tab. Emitted by the tray's "Open Settings"
    /// entry, which lands on {@link Tab::City} — reopening the window from the tray
    /// otherwise leaves it on whatever tab it was hidden on.
    OpenTab(Tab),
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
            Self::OpenTab(tab) => app.emit(name, tab.id()),
        };
        if let Err(e) = result {
            log::warn!("[events] emit {name} failed: {e}");
        }
    }
}
