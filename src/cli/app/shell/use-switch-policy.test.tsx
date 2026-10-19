import { afterEach, describe, expect, test } from "bun:test";
import { Box, Text } from "ink";
import { useSwitchPolicy } from "@/cli/app/shell/use-switch-policy";
import {
  getSwitchPolicy,
  resetSwitchPolicyForTests,
  type SwitchPolicy,
} from "@/cli/app/switch-policy";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";

/**
 * A shell's policy claim, and its release.
 *
 * Two properties matter and neither is visible in the switch code itself: the
 * claim is made on mount (so no click can arrive before it), and unmounting puts
 * the compatibility answer back, so a core mounted without a shell — a component
 * test, a future surface — never inherits "refuse" from a shell that has gone.
 */

function Probe({ policy }: { policy: SwitchPolicy }) {
  useSwitchPolicy(policy);
  return (
    <Box>
      <Text>probe</Text>
    </Box>
  );
}

afterEach(() => {
  resetSwitchPolicyForTests();
  resetInkTtyState();
});

describe("a shell's switch policy", () => {
  test("the mounted shell's answer is in force while it is mounted", async () => {
    expect(getSwitchPolicy()).toBe("queue");
    const shell = mountInkTty(<Probe policy="refuse" />, {
      columns: 80,
      rows: 8,
    });
    try {
      // The frame is read so the effect has run: the claim is made on mount.
      await shell.text();
      expect(getSwitchPolicy()).toBe("refuse");
    } finally {
      shell.stop();
    }
    expect(getSwitchPolicy()).toBe("queue");
  });

  test("the compatibility shell can declare the default explicitly", async () => {
    const shell = mountInkTty(<Probe policy="queue" />, {
      columns: 80,
      rows: 8,
    });
    try {
      await shell.text();
      expect(getSwitchPolicy()).toBe("queue");
    } finally {
      shell.stop();
    }
  });
});
