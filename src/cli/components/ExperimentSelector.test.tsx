import { afterEach, describe, expect, test } from "bun:test";
import { ExperimentSelector } from "@/cli/components/ExperimentSelector";
import type { ExperimentSnapshot } from "@/experiments/types";
import {
  type InkTty,
  mountInkTty,
  resetInkTtyState,
} from "@/test-utils/ink-tty";

/**
 * The experiments overlay: the toolkit's multi-select behind a frame.
 *
 * The face owns three decisions that a picker cannot make for it, and all three
 * are only visible on the frame or on the callback:
 *
 * - an experiment set by the environment renders dimmed and carries the `set by
 *   environment` prefix, because the overlay must show *why* a row will not move;
 * - Space on such a row does nothing, while Enter still confirms the overlay —
 *   its answer is the checkbox set, so a list of env-set experiments has to stay
 *   closable from the keyboard;
 * - what it reports is the *diff* against the snapshot, in the snapshot's order,
 *   with env rows excluded.
 */

const ENTER = "\r";
const SPACE = " ";
const ESCAPE = "\u001B";
const CTRL_C = "\u0003";

const EXPERIMENTS: ExperimentSnapshot[] = [
  {
    id: "ui_v2",
    label: "TUI v2",
    description: "the new shell",
    enabled: false,
    source: "default",
    override: null,
  },
  {
    id: "diffs",
    label: "Diffs",
    description: "worktree diff viewer",
    enabled: true,
    source: "default",
    override: null,
  },
  {
    id: "tui_cron",
    label: "Cron",
    description: "scheduled turns",
    envVar: "HARUYUKI_TUI_CRON",
    enabled: true,
    source: "env",
    override: null,
  },
];

/** The row the cursor bar is on, or "" when nothing is highlighted. */
async function cursorRow(tty: InkTty): Promise<string> {
  return (await tty.rows()).find((row) => row.startsWith("›")) ?? "";
}

afterEach(resetInkTtyState);

describe("ExperimentSelector", () => {
  test("paints the frame, the checkboxes and the env row's reason", async () => {
    const tty = mountInkTty(
      <ExperimentSelector
        experiments={EXPERIMENTS}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
      { columns: 100 },
    );
    try {
      const rows = await tty.rows();
      expect(rows[0]).toBe("> /experiments");
      expect(rows[1]).toBe("─".repeat(100));
      expect(rows.join("\n")).toContain("Toggle Experiments");

      expect(await cursorRow(tty)).toContain("[ ] TUI v2 · the new shell");
      const painted = await tty.text();
      expect(painted).toContain("[✓] Diffs · worktree diff viewer");
      expect(painted).toContain(
        "[✓] Cron · set by environment · scheduled turns",
      );
      expect(painted).toContain(
        "Space to toggle · ↑↓ to navigate · Enter to confirm · Esc to cancel",
      );
    } finally {
      tty.stop();
    }
  });

  test("reports the diff, not the whole selection, and leaves env rows out of it", async () => {
    const confirmed: Array<Array<{ experimentId: string; enabled: boolean }>> =
      [];
    const tty = mountInkTty(
      <ExperimentSelector
        experiments={EXPERIMENTS}
        onConfirm={(changes) => confirmed.push(changes)}
        onCancel={() => {}}
      />,
      { columns: 100 },
    );
    try {
      await tty.press(SPACE);
      // The toggle happened where the user can see it.
      expect(await tty.text()).toContain("[✓] TUI v2");

      await tty.press(ENTER);
      // `Diffs` was already on and `Cron` is env-set, so neither is a change.
      expect(confirmed).toEqual([[{ experimentId: "ui_v2", enabled: true }]]);
    } finally {
      tty.stop();
    }
  });

  test("an env-set row ignores Space but does not trap the overlay", async () => {
    const confirmed: Array<Array<{ experimentId: string; enabled: boolean }>> =
      [];
    const tty = mountInkTty(
      <ExperimentSelector
        experiments={[
          {
            id: "tui_cron",
            label: "Cron",
            description: "scheduled turns",
            enabled: false,
            source: "env",
            override: null,
          },
        ]}
        onConfirm={(changes) => confirmed.push(changes)}
        onCancel={() => {}}
      />,
      { columns: 100 },
    );
    try {
      await tty.press(SPACE);
      expect(await tty.text()).toContain("[ ] Cron");

      await tty.press(ENTER);
      expect(confirmed).toEqual([[]]);
    } finally {
      tty.stop();
    }
  });

  test("Escape and Ctrl+C both cancel", async () => {
    let cancelled = 0;
    const tty = mountInkTty(
      <ExperimentSelector
        experiments={EXPERIMENTS}
        onConfirm={() => {}}
        onCancel={() => {
          cancelled += 1;
        }}
      />,
    );
    try {
      await tty.press(ESCAPE);
      await tty.press(CTRL_C);
      expect(cancelled).toBe(2);
    } finally {
      tty.stop();
    }
  });
});
