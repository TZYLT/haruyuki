import { afterEach, describe, expect, test } from "bun:test";
import { WorktreeDiffSelector } from "@/cli/components/WorktreeDiffSelector";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";
import type { WorktreeDiffOption } from "@/web/worktree-diff-list";

/**
 * The worktree diff list, on the toolkit's frame.
 *
 * The face is a thin wrapper (a rich `renderRow` over `SingleSelectPicker`, which
 * is the toolkit's adapter), so what is worth pinning is what the chrome migration
 * could have disturbed: the header, the rows' own markup, and the three keys.
 */

const DOWN = "\u001B[B";
const ENTER = "\r";
const ESCAPE = "\u001B";

const worktrees: WorktreeDiffOption[] = [
  {
    path: "J:\\repo\\.haruyuki\\worktrees\\alpha",
    name: "alpha",
    branch: "feat/alpha",
    head: "abcdef1",
    isCurrent: true,
    fileCount: 3,
    insertions: 12,
    deletions: 4,
    hasChanges: true,
  },
  {
    path: "J:\\repo\\.haruyuki\\worktrees\\beta",
    name: "beta",
    branch: "feat/beta",
    head: "abcdef2",
    isCurrent: false,
    fileCount: 0,
    insertions: 0,
    deletions: 0,
    hasChanges: false,
  },
];

async function mount(items: WorktreeDiffOption[] = worktrees) {
  const selected: string[] = [];
  let cancels = 0;
  const tty = mountInkTty(
    <WorktreeDiffSelector
      worktrees={items}
      onSelect={(path) => selected.push(path)}
      onCancel={() => {
        cancels += 1;
      }}
    />,
    { columns: 80, rows: 24 },
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  return {
    rows: async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return tty.rows();
    },
    press: tty.press,
    stop: tty.stop,
    selected,
    cancelled: () => cancels,
  };
}

afterEach(() => {
  resetInkTtyState();
});

describe("WorktreeDiffSelector", () => {
  test("draws the frame's chrome and the rich rows", async () => {
    const harness = await mount();
    const rows = await harness.rows();
    const text = rows.join("\n");

    expect(rows[0]).toBe("> /experiments diffs");
    expect(text).toContain("Open Worktree Diff");
    expect(text).toContain("> alpha (current) · feat/alpha · 3 files +12 -4");
    expect(text).toContain("  beta · feat/beta · 0 files +0 -0");
    expect(text).toContain("J:\\repo\\.haruyuki\\worktrees\\alpha");
    expect(text).toContain("Enter select · ↑↓/jk navigate · Esc cancel");
    harness.stop();
  });

  test("↓ moves the cursor and Enter selects that worktree's path", async () => {
    const harness = await mount();
    await harness.press(DOWN);
    expect((await harness.rows()).join("\n")).toContain(
      "> beta · feat/beta · 0 files +0 -0",
    );

    await harness.press(ENTER);
    expect(harness.selected).toEqual(["J:\\repo\\.haruyuki\\worktrees\\beta"]);
    harness.stop();
  });

  test("Escape cancels", async () => {
    const harness = await mount();
    await harness.press(ESCAPE);
    expect(harness.cancelled()).toBe(1);
    harness.stop();
  });

  test("an empty list says so instead of drawing the picker", async () => {
    const harness = await mount([]);
    expect((await harness.rows()).join("\n")).toContain("No worktrees found.");
    harness.stop();
  });
});
