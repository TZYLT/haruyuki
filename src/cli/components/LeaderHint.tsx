import { Box, type DOMElement, measureElement, Text, useStdout } from "ink";
import {
  type RefObject,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useActiveTabIsPage } from "@/cli/app/tabs";
import { colors } from "@/cli/components/colors";
import { terminalTextWidth } from "@/cli/helpers/char-width";
import { owningInputScope } from "@/cli/helpers/focus-ledger";
import { describeChord } from "@/cli/helpers/input-keys";
import { leaderEntries } from "@/cli/helpers/input-router";
import { LEADER_KEY_CHORDS } from "@/cli/helpers/keymap";
import {
  isLeaderArmed,
  isLeaderHelpOpen,
  subscribeToLeader,
} from "@/cli/helpers/leader";
import { createClickTracker } from "@/cli/helpers/mouse-click";
import { registerMouseHandler } from "@/cli/helpers/mouse-router";
import type { MouseReport } from "@/cli/helpers/mouse-sequence";
import {
  isMouseTrackingEnabled,
  subscribeToMouseTracking,
} from "@/cli/helpers/mouse-tracking";
import { getNotice, subscribeToNotice } from "@/cli/helpers/notice";
import {
  useTerminalRows,
  useTerminalWidth,
} from "@/cli/hooks/use-terminal-width";
import {
  getMessageHistorySnapshot,
  subscribeToMessageHistory,
} from "@/cli/notifications/history-store";
import {
  hasMessageHistoryOpener,
  openMessageHistory,
} from "@/cli/notifications/message-history-request";

/**
 * The frame's bottom row: the leader's visible half, the composer's transient
 * notices, and — when there is nothing transient — the context's key hints.
 *
 * A prefix with no affordance is a mode the user cannot see, cannot leave on
 * purpose, and cannot discover — so the prefix announces itself while it is
 * armed, and its `?` entry expands to the list of what it can do.
 *
 * Short notices land in the same slot (`notice.ts`): a mouse toggle and a
 * clipboard write both change nothing on screen, and both are reported in the one
 * line that already exists at the bottom. Notices are drawn first because a
 * notice is the answer to the key just pressed; the prefix line is only reachable
 * again by pressing `Ctrl+X`.
 *
 * **The idle line is the M6 hint row** (《38》§7.3): the keys the *current context*
 * offers, which is why it reads the tab strip's active kind and the mouse mode. It
 * is always exactly one row — the shell's row budget assumes that, so the text
 * truncates rather than wrapping.
 *
 * The subscriptions live here, in a leaf that renders one line most of the time,
 * so an armed prefix re-renders one line instead of the composer or the
 * transcript (the flicker red line covers anything that changes on a keystroke).
 *
 * Entries come from the registered leader bindings, not from a list here: adding
 * one where its behaviour lives is enough.
 */

/**
 * The word the unread tail is built around. Exported for the hit test in the
 * tests: the tail is found in the painted text by this word, so a test can point
 * at the cells the component will claim without hard-coding their column.
 */
export const UNREAD_MARKER = "unread";

/**
 * The tail the idle row appends while messages are unread, `""` otherwise.
 *
 * The chord is printed *beside* the count for the reason the count exists at
 * all: a count with no visible way to clear it is a permanent `unread 1`. It is
 * derived from the leader table, not typed here, so the row cannot name a key
 * that does not open the face (`use-message-history.ts` binds the same chord).
 */
export function unreadSuffix(unread?: number): string {
  if (!unread || unread <= 0) return "";
  const prefix = LEADER_KEY_CHORDS.activate.map(describeChord).join("/");
  const chord = LEADER_KEY_CHORDS.messageHistory.map(describeChord).join("/");
  return ` · ${UNREAD_MARKER} ${unread} · ${prefix} ${chord}`;
}

/**
 * The one-line idle hint: what the current context's keys are.
 *
 * **It only names commands that exist**, and as of P2 all three the design prints
 * do: `/tabs` (the tab list), `/settings` (the Settings page) and `/close` (close
 * this tab). The copy follows 《38》§3.2's frames; the one addition is `Esc back`
 * on a page, because a keyboard user who opens one has to be told how to leave it.
 *
 * With the mouse **off** the line leads with the toggle that turns it back on: a
 * clickable strip whose pointer mode is off is a strip that looks broken, and the
 * leader chord is the only way back — the same reason the page line repeats it.
 */
export function contextHint(input: {
  pageActive: boolean;
  mouseEnabled: boolean;
  /**
   * Notifications the message history has not shown yet (`docs/38` §15.2: show
   * `unread N` at the end of the bottom hint row). Zero says nothing at all —
   * the row is one line at every width, and an `unread 0` would spend columns on
   * the word "nothing".
   */
  unread?: number;
}): string {
  const prefix = LEADER_KEY_CHORDS.activate.map(describeChord).join("/");
  const leader = `${prefix} ? keys`;
  // The count and the key that clears it ride together at the very end, so a row
  // that has to truncate loses them last: "there is something to read" is the one
  // fact the user cannot discover by pressing anything, and the chord printed
  // beside it is the door — the same one the tail's cells click. The tail can
  // still be cut on a narrow row (the longest variant is ~69 columns before it),
  // which is why the hit test declines wherever it is not painted.
  const unread = unreadSuffix(input.unread);
  // Short on purpose: the row is one line at every width, and it is truncated
  // rather than wrapped — so a label that grows past ~60 columns eats the leader
  // hint itself, which is the only way to discover the other keys. `mouse on` is
  // the compromise between "mouse reporting on" (accurate, too long) and
  // `mouse` (ambiguous).
  const enableMouse = `${prefix} ${LEADER_KEY_CHORDS.toggleMouse[0].key} mouse on`;
  if (input.pageActive) {
    return input.mouseEnabled
      ? `click a tab to switch · /tabs · Esc back to chat · ${leader}${unread}`
      : `${enableMouse} · /tabs · Esc back to chat · ${leader}${unread}`;
  }
  return input.mouseEnabled
    ? `Enter send · Shift+Enter newline · /tabs · ${leader}${unread}`
    : `${enableMouse} · Enter send · /tabs · /close · ${leader}${unread}`;
}

/**
 * Which cells of the painted row belong to the unread tail.
 *
 * Columns are 0-based offsets from the row's first cell, the same space the mouse
 * report is converted into. They come from `terminalTextWidth`, never from
 * `.length`: a wide character anywhere before the tail (the row is a generic
 * string builder, so a full-width glyph can land in it) would make a string
 * index aim short of the tail.
 *
 * `paintedWidth` is how much of the row the terminal actually drew (Ink truncates
 * the line to the row's width). Two consequences, both deliberate:
 *
 * - **A row truncated before the tail has no tail.** `paintedWidth < from` makes
 *   the answer `null` instead of a span past the right edge: the cells under the
 *   pointer are then some other hint, and claiming them would open the face from
 *   a piece of text that never named it.
 * - **A row truncated inside the tail** keeps only the painted part clickable,
 *   which is exactly what the user can see.
 */
export interface UnreadSuffixSpan {
  /** 0-based first cell of the tail, inclusive. */
  from: number;
  /** 0-based cell one past the last painted cell of the tail, exclusive. */
  to: number;
}

export function unreadSuffixSpan(
  line: string,
  paintedWidth: number,
): UnreadSuffixSpan | null {
  const marker = line.lastIndexOf(UNREAD_MARKER);
  if (marker < 0) return null;
  // The separator belongs to the target as well: the whole visible tail is one
  // thing, and a two-column word is a small target for a pointer.
  const separator = " · ";
  const start = line.slice(0, marker).endsWith(separator)
    ? marker - separator.length
    : marker;
  const from = terminalTextWidth(line.slice(0, start));
  if (paintedWidth < from) return null;
  const to = Math.min(
    from + terminalTextWidth(line.slice(start)),
    paintedWidth,
  );
  if (to <= from) return null;
  return { from, to };
}

/** Whether a report landed on the unread tail of the measured row. */
function onUnreadTail(
  node: DOMElement,
  line: string,
  report: MouseReport,
): boolean {
  const box = measureElement(node);
  if (box.width <= 0 || box.height <= 0) return false;
  // `measureElement` is 0-based on both axes (the layout tree's origin) while a
  // mouse report is 1-based: the frame's first row and column are 1.
  if (report.row !== box.y + 1) return false;
  const offset = report.column - (box.x + 1);
  if (offset < 0 || offset >= box.width) return false;
  const painted = Math.min(box.width, terminalTextWidth(line));
  const span = unreadSuffixSpan(line, painted);
  return span !== null && offset >= span.from && offset < span.to;
}

/**
 * Make the unread tail a click target that opens the message history face.
 *
 * The tail is the one part of this row with an action behind it, and it is also
 * the part a user has no reason to try: a count that never goes away with nothing
 * to press is a bug report (`unread N` never going away). Clicking the tail is
 * as the chord beside it — it calls the same opener — so the pointer and the
 * keyboard cannot drift apart.
 *
 * Three rules, the same ones the tab row keeps (`use-chrome-clicks.ts`):
 *
 * 1. **Only this row, only those cells.** Anything else returns `false` so the
 *    selection layer and the page rows still get their clicks.
 * 2. **An open overlay or approval owns the pointer.** Raising the face from
 *    under an open surface would switch screens out from under the user, so a
 *    blocked scope declines before measuring anything.
 * 3. **A click is decided by `mouse-click.ts`**, so a drag that began on the tail
 *    and ended elsewhere is not a click.
 *
 * The handler is registered once and reads the painted line through a ref: the
 * line changes on every unread count and resize, and re-registering mid-gesture
 * would reorder the handler chain (`mouse-router.ts`). The registration is on the
 * **chrome** layer because this row is the shell's own bottom line, not content.
 */
function useUnreadTailClicks(input: {
  /** The row box, measured at event time; `null` while another state owns it. */
  rowRef: RefObject<DOMElement | null>;
  /** The text the row painted, `""` when the row shows something else. */
  line: string;
}): void {
  const tracker = useRef(createClickTracker());
  const latest = useRef(input);
  latest.current = input;

  useEffect(() => {
    return registerMouseHandler(
      (report) => {
        if (report.wheel) return false;
        const owning = owningInputScope();
        if (owning === "overlay" || owning === "modal") return false;
        // No door: this shell has no face to raise (the append shell), so the
        // tail is text and the click falls through to whatever is below.
        if (!hasMessageHistoryOpener()) return false;
        const node = latest.current.rowRef.current;
        if (!node) return false;

        if (report.kind === "press") {
          if (!onUnreadTail(node, latest.current.line, report)) return false;
          tracker.current.press(report, Date.now());
          return true;
        }

        if (report.kind === "move") {
          // A press this row claimed owns the motion of its own gesture; handing
          // the tail back would start a selection under the pointer.
          if (!tracker.current.isPending()) return false;
          tracker.current.move(report);
          return true;
        }

        // A press this row claimed owns its release even when it was not a click:
        // returning `false` would hand the tail of a chrome gesture to the
        // selection layer, which reads a release as the end of its own drag.
        const wasPending = tracker.current.isPending();
        const point = tracker.current.release(report, Date.now());
        if (!point) return wasPending;
        // The press cell decides, not the release: that is what makes a drag that
        // began on the tail still a click on it (`mouse-click.ts`).
        const pressed = { ...report, row: point.row, column: point.column };
        if (!onUnreadTail(node, latest.current.line, pressed)) return true;
        openMessageHistory();
        return true;
      },
      { layer: "chrome", name: "unread-tail" },
    );
  }, []);
}

/**
 * The keystroke to print for an entry.
 *
 * A binding may answer to several encodings of *one* key (the leader's help is
 * `?`, which terminals send as `?` or as a modified `/`), so the hint shows the
 * first — the one a person would press — and not the encoding list.
 */
function printKeys(keys: readonly string[]): string {
  return keys[0] ?? "?";
}

/** The count the hint appends, as a scalar so the row does not re-render on rows. */
function unreadCount(): number {
  return getMessageHistorySnapshot().unread;
}

function summarise(entries: ReturnType<typeof leaderEntries>): string {
  return entries
    .map((entry) => {
      const keys = printKeys(entry.keys);
      return entry.label ? `${keys} ${entry.label}` : keys;
    })
    .join(" · ");
}

/**
 * `HARUYUKI_DEBUG_SIZE=1`: the numbers the frame was laid out from, printed on the
 * hint row — the one row that is always on screen, including when the top rows
 * have scrolled off it.
 *
 * Two rounds of the same report ("the tab row is not there") could not be settled
 * from a screenshot because the interesting numbers were never on it: the console's
 * answer and the stream's can disagree, and which one is off is a fact about the
 * machine (2026-10-20). Temporary: the sizes are reconciled in
 * `hooks/use-terminal-width.ts`, and this readout can go once they agree there.
 */
function useSizeReadout(): string {
  const columns = useTerminalWidth();
  const rows = useTerminalRows();
  const { stdout } = useStdout();
  if (process.env.HARUYUKI_DEBUG_SIZE !== "1") return "";
  const ink = `${stdout?.columns ?? "-"}x${stdout?.rows ?? "-"}`;
  return `[q=${columns}x${rows} ink=${ink}]`;
}

export function LeaderHint() {
  const [armed, setArmed] = useState(isLeaderArmed);
  const [helpOpen, setHelpOpen] = useState(isLeaderHelpOpen);
  const notice = useSyncExternalStore(subscribeToNotice, getNotice);
  const unread = useSyncExternalStore(subscribeToMessageHistory, unreadCount);
  const mouseEnabled = useSyncExternalStore(
    subscribeToMouseTracking,
    isMouseTrackingEnabled,
  );
  const pageActive = useActiveTabIsPage();
  const size = useSizeReadout();

  useEffect(() => {
    const sync = () => {
      setArmed(isLeaderArmed());
      setHelpOpen(isLeaderHelpOpen());
    };
    sync();
    return subscribeToLeader(sync);
  }, []);

  // The row the unread tail is clicked on, and the exact text it painted.
  //
  // The line is computed here rather than inside the branch that draws it,
  // because the click handler needs the same string the frame was laid out from:
  // the mouse reports a screen cell, and only this string says which cells the
  // tail occupies (a notice or the armed list paints something else entirely, and
  // then there is no tail to aim at — the row box is not even mounted).
  const rowRef = useRef<DOMElement | null>(null);
  const hint =
    notice === null && !armed
      ? contextHint({ pageActive, mouseEnabled, unread })
      : "";
  const line = hint === "" || !size ? hint : `${size} ${hint}`;
  useUnreadTailClicks({ rowRef, line });

  if (notice !== null) {
    return (
      <Box>
        <Text dimColor wrap="truncate">
          {notice}
        </Text>
      </Box>
    );
  }

  if (!armed) {
    return (
      <Box ref={rowRef}>
        <Text dimColor wrap="truncate">
          {line}
        </Text>
      </Box>
    );
  }

  const prefix = LEADER_KEY_CHORDS.activate.map(describeChord).join("/");
  const entries = leaderEntries();

  if (!helpOpen) {
    // One row, like the idle hint, and **one Text**: the shell's row budget counts
    // this line, and an armed prefix that wraps to a second row takes that row from
    // the band (which shifts every row under it). Two sibling `<Text>`s in a row box
    // do not do it — Yoga gives the second one its content width, so `wrap="truncate"`
    // has nothing to cut and the terminal wraps the physical line instead. `?` is the
    // door to the full list, so truncating here loses nothing a key press cannot
    // recover.
    return (
      <Box>
        <Text dimColor wrap="truncate">
          {`${prefix} … ${summarise(entries)}`}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {entries.map((entry) => (
        <Text key={entry.id} dimColor>
          {prefix} {printKeys(entry.keys)} —{" "}
          <Text color={colors.text.dim}>{entry.label ?? entry.id}</Text>
        </Text>
      ))}
      <Text dimColor>esc exit</Text>
    </Box>
  );
}
