import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { colors } from "@/cli/components/colors";
import { describeChord } from "@/cli/helpers/input-keys";
import { leaderEntries } from "@/cli/helpers/input-router";
import { LEADER_KEY_CHORDS } from "@/cli/helpers/keymap";
import {
  isLeaderArmed,
  isLeaderHelpOpen,
  subscribeToLeader,
} from "@/cli/helpers/leader";

/**
 * The leader's visible half.
 *
 * A prefix with no affordance is a mode the user cannot see, cannot leave on
 * purpose, and cannot discover — so the prefix announces itself while it is
 * armed, and its `?` entry expands to the list of what it can do.
 *
 * The subscription lives here, in a leaf that renders nothing most of the time,
 * so an armed prefix re-renders one line instead of the composer or the
 * transcript (the flicker red line covers anything that changes on a keystroke).
 *
 * Entries come from the registered leader bindings, not from a list here: adding
 * one where its behaviour lives is enough, which is what M6 needs when it fills
 * the table from the command registry.
 */

function summarise(entries: ReturnType<typeof leaderEntries>): string {
  return entries
    .map((entry) => {
      const keys = entry.keys.join("/");
      return entry.label ? `${keys} ${entry.label}` : keys;
    })
    .join(" · ");
}

export function LeaderHint() {
  const [armed, setArmed] = useState(isLeaderArmed);
  const [helpOpen, setHelpOpen] = useState(isLeaderHelpOpen);

  useEffect(() => {
    const sync = () => {
      setArmed(isLeaderArmed());
      setHelpOpen(isLeaderHelpOpen());
    };
    sync();
    return subscribeToLeader(sync);
  }, []);

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
          {prefix} {entry.keys.join("/")} —{" "}
          <Text color={colors.text.dim}>{entry.label ?? entry.id}</Text>
        </Text>
      ))}
      <Text dimColor>esc 退出</Text>
    </Box>
  );
}
