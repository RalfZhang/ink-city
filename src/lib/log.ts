import { error as pluginError, info as pluginInfo, warn as pluginWarn } from "@tauri-apps/plugin-log";

// Thin wrapper around @tauri-apps/plugin-log: keeps the existing console.*
// output (immediate, visible in devtools while developing) and additionally
// persists the line to the log file the Rust side manages (see the
// `tauri_plugin_log` registration in src-tauri/src/lib.rs and the "open log
// folder" button in the About tab) — so a user hitting a bug has something to
// attach, instead of output only devtools would have shown. Fire-and-forget:
// the plugin call is IPC, and a logging failure shouldn't affect the caller.

const join = (message: string, args: unknown[]) =>
  args.length === 0 ? message : `${message} ${args.map(String).join(" ")}`;

export function logInfo(message: string, ...args: unknown[]): void {
  console.log(message, ...args);
  void pluginInfo(join(message, args));
}

export function logWarn(message: string, ...args: unknown[]): void {
  console.warn(message, ...args);
  void pluginWarn(join(message, args));
}

export function logError(message: string, ...args: unknown[]): void {
  console.error(message, ...args);
  void pluginError(join(message, args));
}
