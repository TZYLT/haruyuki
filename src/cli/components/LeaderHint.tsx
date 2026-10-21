import { Box, Text, useStdout } from "ink";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useActiveTabIsPage } from "@/cli/app/tabs";
import { colors } from "@/cli/components/colors";
import { describeChord } from "@/cli/helpers/input-keys";
import { leaderEntries } from "@/cli/helpers/input-router";
import { LEADER_KEY_CHORDS } from "@/cli/helpers/keymap";
import {
  isLeaderArmed,
  isLeaderHelpOpen,
  subscribeToLeader,
} from "@/cli/helpers/leader";
import {
  isMouseTrackingEnabled,
  subscribeToMouseTracking,
} from "@/cli/helpers/mouse-tracking";
import { getNotice, subscribeToNotice } from "@/cli/helpers/notice";
import {
  useTerminalRows,
  useTerminalWidth,
} from "@/cli/hooks/use-terminal-width";

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
 * The one-line idle hint: what the current context's keys are.
 *
 * **It only names commands that exist**, and as of P2 all three the design prints
 * do: `/tabs` (the tab list), `/settings` (the Settings page) and `/close` (close
 * this tab). The copy follows 《38》§3.2's frames; the one addition is `Esc 回会话`
 * on a page, because a keyboard user who opens one has to be told how to leave it.
 *
 * With the mouse **off** the line leads with the toggle that turns it back on: a
 * clickable strip whose pointer mode is off is a strip that looks broken, and the
 * leader chord is the only way back — the same reason the page line repeats it.
 */
export function contextHint(input: {
  pageActive: boolean;
  mouseEnabled: boolean;
}): string {
  const prefix = LEADER_KEY_CHORDS.activate.map(describeChord).join("/");
  const leader = `${prefix} ? 键位`;
  // Short on purpose: the row is one line at every width, and it is truncated
  // rather than wrapped — so a label that grows past ~60 columns eats the leader
  // hint itself, which is the only way to discover the other keys. `开鼠标` is the
  // compromise between "打开鼠标上报" (accurate, too long) and `鼠标` (ambiguous).
  const enableMouse = `${prefix} ${LEADER_KEY_CHORDS.toggleMouse[0].key} 开鼠标`;
  if (input.pageActive) {
    return input.mouseEnabled
      ? `点标签切换 · /tabs 标签 · Esc 回会话 · ${leader}`
      : `${enableMouse} · /tabs 标签 · Esc 回会话 · ${leader}`;
  }
  return input.mouseEnabled
    ? `Enter 发送 · Shift+Enter 换行 · /tabs 标签 · ${leader}`
    : `${enableMouse} · Enter 发送 · /tabs 标签 · /close 关 · ${leader}`;
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
    const hint = contextHint({ pageActive, mouseEnabled });
    return (
      <Box>
        <Text dimColor wrap="truncate">
          {size ? `${size} ${hint}` : hint}
        </Text>
      </Box>
    );
  }

  const prefix = LEADER_KEY_CHORDS.activate.map(describeChord).join("/");
  const entries = leaderEntries();

  if (!helpOpen) {
    return (
      <Box>
        <Text dimColor>{prefix} … </Text>
        <Text dimColor>{summarise(entries)}</Text>
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
      <Text dimColor>esc 退出</Text>
    </Box>
  );
}
