import { afterEach, describe, expect, test } from "bun:test";
import { Text } from "ink";
import type { AppViewProps } from "@/cli/app/AppView";
import { ShellFrame } from "@/cli/app/shell/ShellFrame";
import type { AppShellProps } from "@/cli/app/shell/types";
import {
  consultedInputScopes,
  owningInputScope,
} from "@/cli/helpers/focus-ledger";
import type { ApprovalRequest } from "@/cli/helpers/stream";
import { useKeyBindings } from "@/cli/hooks/use-input-router";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";

/**
 * An open overlay versus a pending approval (§4.5 ruling c).
 *
 * Both used to claim a layer of the input ledger at once. `modal` outranks
 * `overlay` in `INPUT_SCOPE_PRIORITY` and the router consults only the owning
 * scope, so the approval won and every key a *migrated* overlay binds through
 * the router — arrows, Enter, Escape — was never offered to it: the selector
 * was frozen while an approval was pending, with the approval answering the
 * keys instead. The ruling is that the overlay the user opened owns the
 * keyboard and the approval waits behind it, which is only true if the frame
 * claims one layer and hands the transcript no current approval to draw.
 *
 * The assertion is the rendered frame plus the routing decision, not the state
 * a handler set: `src/cli/AGENTS.md` records the class of bug where a key path
 * is wired correctly and the screen is empty.
 */

const UP = "\u001b[A";

const APPROVAL: ApprovalRequest = {
  toolCallId: "call-1",
  toolName: "Bash",
  toolArgs: JSON.stringify({ command: "ls" }),
};

let seenApproval: AppViewProps["currentApproval"];
let overlayNavigations = 0;

/** The transcript region, replaced: what it is handed is what it would draw. */
function StubTranscript({ currentApproval }: AppViewProps) {
  seenApproval = currentApproval;
  return <Text>{currentApproval ? "approval is current" : "stub"}</Text>;
}

/** A migrated overlay's side of the contract: one `overlay`-scope binding. */
function OverlayBindingProbe() {
  useKeyBindings("arbitration-probe", [
    {
      scope: "overlay",
      bindings: [
        {
          id: "arbitration-probe.up",
          chords: [{ key: "upArrow" }],
          run: () => {
            overlayNavigations += 1;
            return "consumed";
          },
        },
      ],
    },
  ]);
  return null;
}

function shellProps(overrides: Partial<AppShellProps>): AppShellProps {
  return {
    activeOverlay: null,
    currentApproval: undefined,
    currentApprovalContext: undefined,
    pendingApprovals: [],
    projectDirectory: "/tmp/haruyuki-arbitration",
    terminalTitleConfigRefreshEpoch: 0,
    terminalTitleData: { agentName: "agent-1", version: "0.0.0-test" },
    terminalTitlePreviewOverride: null,
    terminalTitleTaskRunning: false,
    shouldAnimate: false,
    ...overrides,
  } as unknown as AppShellProps;
}

function mountShell(overrides: Partial<AppShellProps>) {
  return mountInkTty(
    <>
      <ShellFrame {...shellProps(overrides)} transcript={StubTranscript} />
      <OverlayBindingProbe />
    </>,
  );
}

afterEach(() => {
  resetInkTtyState();
  seenApproval = undefined;
  overlayNavigations = 0;
});

describe("an open overlay and a pending approval", () => {
  test("the overlay owns the keyboard, and the approval becomes a stub", async () => {
    const shell = mountShell({
      activeOverlay: "model",
      currentApproval: APPROVAL,
      pendingApprovals: [APPROVAL],
    });
    try {
      const painted = await shell.text();

      expect(owningInputScope()).toBe("overlay");
      expect(consultedInputScopes()).toEqual(["overlay", "system"]);
      // The transcript is handed no current approval, so it draws the compact
      // stub instead of the approval UI it would otherwise answer keys with.
      expect(seenApproval).toBeUndefined();
      expect(painted).toContain("stub");
      expect(painted).not.toContain("approval is current");

      await shell.press(UP);
      expect(overlayNavigations).toBe(1);
    } finally {
      shell.stop();
    }
  });

  test("with no overlay, the approval owns the keyboard", async () => {
    const shell = mountShell({
      currentApproval: APPROVAL,
      pendingApprovals: [APPROVAL],
    });
    try {
      const painted = await shell.text();

      expect(owningInputScope()).toBe("modal");
      expect(seenApproval).toBe(APPROVAL);
      expect(painted).toContain("approval is current");

      await shell.press(UP);
      // The overlay layer is not consulted while the approval owns input, so a
      // migrated selector cannot navigate underneath the approval.
      expect(overlayNavigations).toBe(0);
    } finally {
      shell.stop();
    }
  });

  test("closing the overlay gives the approval back", async () => {
    const pending = {
      currentApproval: APPROVAL,
      pendingApprovals: [APPROVAL],
    };
    const withOverlay = mountShell({ ...pending, activeOverlay: "model" });
    withOverlay.stop();
    resetInkTtyState();

    const without = mountShell(pending);
    try {
      expect(owningInputScope()).toBe("modal");
      expect(seenApproval).toBe(APPROVAL);
    } finally {
      without.stop();
    }
  });
});
