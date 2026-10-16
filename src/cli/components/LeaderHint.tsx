import { Box, Text } from "ink";
import { useEffect, useState, useSyncExternalStore } from "react";
import { colors } from "@/cli/components/colors";
import { describeChord } from "@/cli/helpers/input-keys";
import { leaderEntries } from "@/cli/helpers/input-router";
import { LEADER_KEY_CHORDS } from "@/cli/helpers/keymap";
import {
  isLeaderArmed,
  isLeaderHelpOpen,
  subscribeToLeader,
} from "@/cli/helpers/leader";
import { getNotice, subscribeToNotice } from "@/cli/helpers/notice";

/**
 * The leader's visible half, and the composer's one-line transient notices.
 *
 * A prefix with no affordance is a mode the user cannot see, cannot leave on
 * purpose, and cannot discover — so the prefix announces itself while it is
 * armed, and its `?` entry expands to the list of what it can do.
 *
 * Short notices land in the same slot (`notice.ts`): a mouse toggle and a
 * clipboard write both change nothing on screen, and both are reported in the
 * one line that already exists above the input. Notices are drawn first because a
 * notice is the answer to the key just pressed; the prefix line is only reachable
 * again by pressing `Ctrl+X`.
 *
 * The subscriptions live here, in a leaf that renders nothing most of the time,
 * so an armed prefix re-renders one line instead of the composer or the
 * transcript (the flicker red line covers anything that changes on a keystroke).
 *
 * Entries come from the registered leader bindings, not from a list here: adding
 * one where its behaviour lives is enough, which is what M6 needs when it fills
 * the table from the command registry.
 */

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
        <Text dimColor>{notice}</Text>
      </Box>
    );
  }

  if (!armed) return null;

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
