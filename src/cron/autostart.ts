/**
 * OS autostart registration (F-05, M4).
 *
 * Registers a user-level timer (Windows `schtasks` / macOS LaunchAgent /
 * systemd user timer with a crontab fallback) that wakes the short-lived host
 * once a minute. Nothing here writes a system-level entry, and every command
 * runs through an injectable runner so tests assert the command line instead of
 * touching the machine.
 *
 * M0 freeze: the names below are part of the frozen barrel. M4 fills the body.
 */

import type { AutostartStatus } from "./cron-types";

/** M4 replaces the body. */
export async function getAutostartStatus(): Promise<AutostartStatus> {
  throw new Error("getAutostartStatus is not implemented yet (F-05 M4).");
}

/** M4 replaces the body. Idempotent: re-registering overwrites one entry. */
export async function registerAutostart(): Promise<AutostartStatus> {
  throw new Error("registerAutostart is not implemented yet (F-05 M4).");
}

/** M4 replaces the body. Only explicit shutdowns call this (Q-43). */
export async function unregisterAutostart(): Promise<AutostartStatus> {
  throw new Error("unregisterAutostart is not implemented yet (F-05 M4).");
}
