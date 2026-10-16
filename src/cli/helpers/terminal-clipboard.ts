import { copyToClipboard } from "./clipboard";

/**
 * Putting text on the clipboard from inside a full-screen TUI.
 *
 * Two channels, because neither works everywhere:
 *
 * - **OSC 52** asks the *terminal* to set the clipboard. It is the only channel
 *   that works over ssh and through tmux, and it is fire-and-forget: the terminal
 *   sends no reply, so a policy that blocks it (Windows Terminal ships with OSC 52
 *   disabled) is indistinguishable from success.
 * - **The platform command** (`pbcopy`, `clip`, `xclip`) works locally and reports
 *   failure. It is what actually puts text on the clipboard on Windows.
 *
 * That asymmetry decides the policy: OSC 52 is written **first** and the local
 * command is attempted **as well**, not only after a failure we cannot observe.
 * Whichever channel the terminal honours ends up with the same text, so doing
 * both is not a conflict — and the result says which ones were *attempted*.
 *
 * A very large payload is deliberately not sent over OSC 52: terminals that
 * accept it may buffer or truncate it, and a half-delivered clipboard is worse
 * than a local-only one. The local command handles the big selections.
 */

export interface ClipboardStream {
  write(chunk: string): unknown;
  isTTY?: boolean;
}

/** Roughly 200 KB of base64, past which OSC 52 stops being trustworthy. */
export const MAX_OSC52_BYTES = 200_000;

export type ClipboardMethod = "osc52+local" | "osc52" | "local" | "none";

export interface ClipboardResult {
  method: ClipboardMethod;
  /** The text's byte length, for the notice line. */
  bytes: number;
}

/** The OSC 52 sequence that asks the terminal to set its clipboard. */
export function osc52Sequence(text: string, target = "c"): string {
  return `\u001B]52;${target};${Buffer.from(text, "utf8").toString("base64")}\u0007`;
}

export interface CopyTextOptions {
  stream?: ClipboardStream;
  /** Injected in tests; the platform command by default. */
  copyLocally?: (text: string) => boolean;
}

/**
 * Copy `text`, trying both channels. The result names what was attempted, which
 * is what the notice reports — the app cannot promise delivery, only the attempt.
 */
export function copyText(
  text: string,
  options: CopyTextOptions = {},
): ClipboardResult {
  const bytes = Buffer.byteLength(text, "utf8");
  if (text.length === 0) return { method: "none", bytes: 0 };

  const stream = options.stream ?? process.stdout;
  const sequence = osc52Sequence(text);
  const sentOverOsc52 =
    bytes <= MAX_OSC52_BYTES &&
    stream.isTTY === true &&
    writeQuietly(stream, sequence);

  const copiedLocally = (options.copyLocally ?? copyToClipboard)(text);

  if (sentOverOsc52 && copiedLocally) return { method: "osc52+local", bytes };
  if (sentOverOsc52) return { method: "osc52", bytes };
  if (copiedLocally) return { method: "local", bytes };
  return { method: "none", bytes };
}

function writeQuietly(stream: ClipboardStream, chunk: string): boolean {
  try {
    stream.write(chunk);
    return true;
  } catch {
    return false;
  }
}
