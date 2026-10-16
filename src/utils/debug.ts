import { APP_DIR_NAME, APP_SUBDIRS } from "@/utils/app-paths";
// src/utils/debug.ts
// Debug logging utility.
//
// Screen output: controlled by HARUYUKI_DEBUG=1 (or DEBUG=1 for legacy compatibility),
// or HARUYUKI_DEBUG_FILE for a custom path. It stops while an interactive session
// owns the terminal (see `screenOutputSuppressed`); HARUYUKI_DEBUG_SCREEN=1 forces it.
// File output:   always written to ~/.haruyuki/logs/debug/{agent-id}/{session-id}.log
//                once debugLogFile.init() has been called.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { format } from "node:util";

// ---------------------------------------------------------------------------
// Screen-output helpers (unchanged behaviour)
// ---------------------------------------------------------------------------

/**
 * Check if debug mode is enabled via HARUYUKI_DEBUG env var.
 * Also accepts DEBUG=1|true for legacy compatibility.
 */
export function isDebugEnabled(): boolean {
  const haruyukiDebug = process.env.HARUYUKI_DEBUG;
  const legacyDebug = process.env.DEBUG;
  return (
    haruyukiDebug === "1" ||
    haruyukiDebug === "true" ||
    legacyDebug === "1" ||
    legacyDebug === "true"
  );
}

function getDebugFile(): string | null {
  const path = process.env.HARUYUKI_DEBUG_FILE;
  return path && path.trim().length > 0 ? path : null;
}

/**
 * Whether screen output is still allowed.
 *
 * The interactive TUI hands the screen to Ink, and a line written straight to
 * stdout/stderr while Ink is drawing lands inside its frame: Ink only learns
 * about a patched `console` write by erasing the frame and repainting it, so
 * every debug line costs a full clear/repaint (visible flicker) — and in the
 * append shell the static and live regions can end up out of step, printing
 * overlapping output. `debugLogFile.init()` is the moment a session's log file
 * exists, i.e. the interactive session is taking the screen, so screen output
 * stops there. Every line still goes to that file unconditionally (and to
 * `HARUYUKI_DEBUG_FILE` when that is set, which always wins over the screen).
 *
 * `HARUYUKI_DEBUG_SCREEN=1` forces screen output back on for a session that is
 * being debugged on the terminal itself.
 */
let screenOutputSuppressed = false;

/** Test seam: allow screen output again (module state survives between files). */
export function resetDebugScreenSuppression(): void {
  screenOutputSuppressed = false;
}

/** Print to screen (or HARUYUKI_DEBUG_FILE). Only called when HARUYUKI_DEBUG=1. */
function printDebugLine(line: string, level: "log" | "warn" = "log"): void {
  const debugFile = getDebugFile();
  if (debugFile) {
    try {
      appendFileSync(debugFile, line, { encoding: "utf8" });
      return;
    } catch {
      // Fall back to console if file write fails
    }
  }
  if (screenOutputSuppressed) return;
  const colored =
    level === "warn"
      ? `\x1b[38;5;167m${line.trimEnd()}\x1b[0m` // muted red
      : `\x1b[38;5;179m${line.trimEnd()}\x1b[0m`; // muted golden yellow
  console.error(colored);
}

// ---------------------------------------------------------------------------
// Always-on debug log file
// ---------------------------------------------------------------------------

const DEBUG_LOG_DIR = join(homedir(), APP_DIR_NAME, APP_SUBDIRS.logs, "debug");
const MAX_SESSION_FILES = 5;
const MAX_LOG_BYTES = 10 * 1024 * 1024; // 10 MB per session file
const DEFAULT_TAIL_LINES = 50;

interface DebugLogFileOptions {
  /** Override the log root (tests). Defaults to ~/.haruyuki/logs/debug. */
  dir?: string;
  /** Override the per-file size cap in bytes (tests). */
  maxBytes?: number;
}

class DebugLogFile {
  private logPath: string | null = null;
  private agentDir: string | null = null;
  private dirCreated = false;
  private bytesWritten = 0;
  private maxBytes = MAX_LOG_BYTES;
  private truncationNoted = false;

  /**
   * Initialize for an agent + session. Call once at session start.
   * After this, every debugLog/debugWarn call is persisted to disk.
   * Respects HARUYUKI_CODE_TELEM=0 — skips file logging when telemetry is disabled.
   */
  init(
    agentId: string,
    sessionId: string,
    options: DebugLogFileOptions = {},
  ): void {
    // The interactive session is about to own the terminal (this is called once
    // per session, from the app, with the agent it resolved). From here on screen
    // output would land inside Ink's frame, so it goes to this file instead —
    // see `screenOutputSuppressed`.
    screenOutputSuppressed = process.env.HARUYUKI_DEBUG_SCREEN !== "1";

    const telem = process.env.HARUYUKI_CODE_TELEM;
    if (telem === "0" || telem === "false") return;

    this.agentDir = join(options.dir ?? DEBUG_LOG_DIR, agentId);
    this.logPath = join(this.agentDir, `${sessionId}.log`);
    this.maxBytes = options.maxBytes ?? MAX_LOG_BYTES;
    this.dirCreated = false;
    this.bytesWritten = 0;
    this.truncationNoted = false;
    this.pruneOldSessions();
  }

  /** Append a single line to the log file (best-effort, sync). */
  appendLine(line: string): void {
    if (!this.logPath) return;
    // Cap per-file size so a long session cannot fill the disk. Unlike the
    // listener session log we do not rotate here: the file is addressed by
    // session id, and getTail() reads this exact path.
    if (this.bytesWritten >= this.maxBytes) {
      if (!this.truncationNoted) {
        this.truncationNoted = true;
        this.writeRaw(
          `${new Date().toISOString()} [debug] log truncated after ${this.maxBytes} bytes\n`,
        );
      }
      return;
    }
    this.writeRaw(line);
  }

  private writeRaw(line: string): void {
    if (!this.logPath) return;
    this.ensureDir();
    try {
      appendFileSync(this.logPath, line, { encoding: "utf8" });
      this.bytesWritten += Buffer.byteLength(line, "utf8");
    } catch {
      // Best-effort — never crash the app for debug logging
    }
  }

  /** Read the last N lines from the current log file. */
  getTail(maxLines = DEFAULT_TAIL_LINES): string | undefined {
    if (!this.logPath) return undefined;
    try {
      if (!existsSync(this.logPath)) return undefined;
      const content = readFileSync(this.logPath, "utf8");
      const lines = content.trimEnd().split("\n");
      return lines.slice(-maxLines).join("\n");
    } catch {
      return undefined;
    }
  }

  private ensureDir(): void {
    if (this.dirCreated || !this.agentDir) return;
    try {
      if (!existsSync(this.agentDir)) {
        mkdirSync(this.agentDir, { recursive: true });
      }
      this.dirCreated = true;
    } catch {
      // Silently ignore — will retry on next append
    }
  }

  private pruneOldSessions(): void {
    if (!this.agentDir) return;
    try {
      if (!existsSync(this.agentDir)) return;
      const files = readdirSync(this.agentDir)
        .filter((f) => f.endsWith(".log"))
        .sort();
      if (files.length >= MAX_SESSION_FILES) {
        const toDelete = files.slice(0, files.length - MAX_SESSION_FILES + 1);
        for (const file of toDelete) {
          try {
            unlinkSync(join(this.agentDir, file));
          } catch {
            // best-effort cleanup
          }
        }
      }
    } catch {
      // best-effort cleanup
    }
  }
}

/** Singleton — import and call init() once per session. */
export const debugLogFile = new DebugLogFile();

// ---------------------------------------------------------------------------
// Core write function
// ---------------------------------------------------------------------------

function writeDebugLine(
  prefix: string,
  message: string,
  args: unknown[],
  level: "log" | "warn" = "log",
): void {
  const ts = new Date().toISOString();
  const body = format(`[${prefix}] ${message}`, ...args);
  const line = `${ts} ${body}\n`;

  // Always persist to the session log file
  debugLogFile.appendLine(line);

  // Screen output only when HARUYUKI_DEBUG is on
  if (isDebugEnabled()) {
    printDebugLine(line, level);
  }
}

// ---------------------------------------------------------------------------
// Public API (unchanged signatures)
// ---------------------------------------------------------------------------

/**
 * Log a debug message. Always written to the session log file.
 * Only printed to screen when HARUYUKI_DEBUG=1.
 */
export function debugLog(
  prefix: string,
  message: string,
  ...args: unknown[]
): void {
  writeDebugLine(prefix, message, args);
}

/**
 * Log a debug warning. Always written to the session log file.
 * Only printed to screen when HARUYUKI_DEBUG=1.
 */
export function debugWarn(
  prefix: string,
  message: string,
  ...args: unknown[]
): void {
  writeDebugLine(prefix, `WARN: ${message}`, args, "warn");
}
