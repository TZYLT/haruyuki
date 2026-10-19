import { Box, Text } from "ink";
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
 * **It only names commands that exist.** Both the design's hint row (《38》§3.2) and
 * this one want `/tabs`, `/close` and `/settings` printed here, but those commands
 * are the `page` batch's (P2) — on a keyboard-only fallback a hint that resolves to
 * "unknown command" is worse than no hint, so the row says what the app can
 * actually do and P2 replaces the copy when the commands land. What it does *not*
 * leave out is the way back: with the mouse off and a page in the main area, the
 * leader's own mouse toggle is the only way out of it.
 */
export function contextHint(input: {
  pageActive: boolean;
  mouseEnabled: boolean;
}): string {
  const prefix = LEADER_KEY_CHORDS.activate.map(describeChord).join("/");
  const leader = `${prefix} ? 键位`;
  const enableMouse = `${prefix} ${LEADER_KEY_CHORDS.toggleMouse[0].key} 打开鼠标`;
  if (input.pageActive) {
    return input.mouseEnabled
      ? `点标签切换 · ${leader}`
      : `${enableMouse} · ${leader}`;
  }
  return input.mouseEnabled
    ? `Enter 发送 · Shift+Enter 换行 · 拖拽选中 · ${leader}`
    : `Enter 发送 · Shift+Enter 换行 · ${leader}`;
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

export function LeaderHint() {
  const [armed, setArmed] = useState(isLeaderArmed);
  const [helpOpen, setHelpOpen] = useState(isLeaderHelpOpen);
  const notice = useSyncExternalStore(subscribeToNotice, getNotice);
  const mouseEnabled = useSyncExternalStore(
    subscribeToMouseTracking,
    isMouseTrackingEnabled,
  );
  const pageActive = useActiveTabIsPage();

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
    return (
      <Box>
        <Text dimColor wrap="truncate">
          {contextHint({ pageActive, mouseEnabled })}
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
