import { APP_DIR_NAME, APP_SUBDIRS } from "@/utils/app-paths";
/**
 * Local JSONL log for user feedback and channel error reports.
 *
 * These payloads used to be POSTed to `https://api.letta.com/v1/metadata/
 * feedback` — from the TUI `/maintenance feedback` command, from channel feedback, from a
 * channel lifecycle error report, and from the reflection-threshold alert. This
 * fork has no Cloud backend, so that endpoint is unreachable by design and the
 * submissions were the last remaining egress of user content.
 *
 * They are recorded here instead: a support report still survives on disk, and
 * the slash command can tell the user where it went. The write is best-effort
 * and size-bounded exactly like the boundary-error log; see `./jsonl-log`.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { createJsonlLog } from "./jsonl-log";

const FEEDBACK_LOG_DIR = join(homedir(), APP_DIR_NAME, APP_SUBDIRS.logs);
const FEEDBACK_LOG_BASENAME = "feedback";

/** Per-file byte cap. The active file rotates once it reaches this size. */
export const MAX_FEEDBACK_LOG_BYTES = 10 * 1024 * 1024;
/** Retained files, active file included: worst case 10 files x 10 MB. */
export const MAX_FEEDBACK_LOG_FILES = 10;

const feedbackLog = createJsonlLog({
  basename: FEEDBACK_LOG_BASENAME,
  defaultDir: FEEDBACK_LOG_DIR,
  maxBytes: MAX_FEEDBACK_LOG_BYTES,
  maxFiles: MAX_FEEDBACK_LOG_FILES,
});

export interface FeedbackLogOptions {
  /** Override the log directory (tests). Defaults to `~/.haruyuki/logs`. */
  dir?: string;
  /** Override the per-file byte cap (tests). */
  maxBytes?: number;
  /** Override the retained file count, active file included (tests). */
  maxFiles?: number;
}

/** Absolute path of the file this module appends to. */
export function localFeedbackLogPath(options: FeedbackLogOptions = {}): string {
  return feedbackLog.path(options);
}

/**
 * Append one JSON line holding the submission payload. Never throws, never
 * blocks on the network.
 */
export function appendLocalFeedback(
  entry: Record<string, unknown>,
  options: FeedbackLogOptions = {},
): void {
  feedbackLog.append({ ts: new Date().toISOString(), ...entry }, options);
}
