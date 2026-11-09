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
use crate::pipeline::RunEnd;

/// What `FrontendEvent::OpenView` opens the window on: the home (the day's map and
/// its game) or the settings sheet over it. An enum rather than a bare string
/// because the frontend matches on these exact names (`apps/desktop/src/App.tsx`).
pub enum View {
    Home,
    Settings,
}

impl View {
    /// The name the frontend matches on.
    fn id(&self) -> &'static str {
        match self {
            Self::Home => "home",
            Self::Settings => "settings",
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
    /// Render pipeline finished: which requests it served, and how (`RunEnd`).
    PipelineEnd(RunEnd),
    /// Ask the frontend to show a view. Emitted by the tray's "open" entry: "Open
    /// Game" lands on the home, "Open Settings" on the sheet — reopening the window
    /// otherwise leaves it as it was hidden.
    OpenView(View),
    /// The window was just hidden (its close button). The
    /// frontend lets go of what only made sense while it was looked at: an unsaved
    /// preview, the open sheet.
    WindowHidden,
    /// The window was just shown (a launch, the tray, a second launch). The map is
    /// only read and drawn while it's on screen (`useMapData`), so this sets it going.
    WindowShown,
}

impl FrontendEvent {
    /// The event name the frontend listens on. Centralized here so a typo can't
    /// silently split a channel across emit and listen sides.
    pub fn name(&self) -> &'static str {
        match self {
            Self::StatusChanged(_) => "status:changed",
            Self::PipelineStart => "pipeline:start",
            Self::PipelineEnd(_) => "pipeline:end",
            Self::OpenView(_) => "open-view",
            Self::WindowHidden => "window:hidden",
            Self::WindowShown => "window:shown",
        }
    }

    /// The one place that actually calls `app.emit`. Emitting to a hidden (not
    /// destroyed) webview is harmless, so there is no window gate.
    pub fn emit(self, app: &AppHandle) {
        let name = self.name();
        let result = match self {
            Self::StatusChanged(s) => app.emit(name, s),
            Self::PipelineStart => app.emit(name, ()),
            Self::PipelineEnd(end) => app.emit(name, end),
            Self::OpenView(view) => app.emit(name, view.id()),
            Self::WindowHidden => app.emit(name, ()),
            Self::WindowShown => app.emit(name, ()),
        };
        if let Err(e) = result {
            log::warn!("[events] emit {name} failed: {e}");
        }
    }
}
