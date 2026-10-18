import { afterEach, describe, expect, test } from "bun:test";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";
import { ApprovalOptions } from "./ApprovalOptions";

/**
 * The option list all four inline approvals end with.
 *
 * This replaces four copies of the same state, the same `useInput` body and the
 * same eighty lines of JSX, so the interesting question is whether anything
 * moved. It did not: a temporary harness captured the frame *and* the recorded
 * actions for all four components across both persistence settings and fourteen
 * key sequences, at HEAD and after the rewrite, and the two capture files are
 * byte-identical (112 lines each).
 *
 * What the assertions below can check honestly is narrower than that matrix, and
 * the reason is worth stating, because it is a property of the harness and not
 * of this component: a `memo()`-wrapped component keeps its `useInput` handler's
 * captured state at the first render (Ink subscribes the handler through
 * React's `useEffectEvent`), so a key whose meaning depends on state that an
 * *earlier key in the same mount* changed still reads the old value here --
 * ↓ then Enter records `approve`, not `always`. The four copies did exactly the
 * same before the rewrite, which is what the parity capture shows, and the app's
 * own re-render cadence is what L3 has to check (`docs/36` M5). So: frames pin
 * the rendering, and the keys pinned here are the ones whose meaning does not
 * depend on a previous key.
 */

const DOWN = "\u001b[B";
const ENTER = "\r";
const ESC = "\u001b";
const CTRL_C = "\u0003";

async function mountApprovalOptions(
  overrides: { allowPersistence?: boolean; isFocused?: boolean } = {},
) {
  const actions: string[] = [];
  const shell = mountInkTty(
    <ApprovalOptions
      allowPersistence={overrides.allowPersistence ?? true}
      alwaysLabel="Always allow"
      isFocused={overrides.isFocused ?? true}
      marginTop={1}
      onApprove={() => actions.push("approve")}
      onApproveAlways={() => actions.push("always")}
      onCancel={() => actions.push("cancel")}
      onDeny={(reason) => actions.push(`deny:${reason}`)}
    />,
    { columns: 60, rows: 12 },
  );
  await shell.rows();
  return { shell, actions };
}

/** A frame read between keys: the next key must not arrive mid-render. */
async function pressKeys(
  shell: ReturnType<typeof mountInkTty>,
  keys: string[],
): Promise<void> {
  for (const key of keys) {
    await shell.press(key);
    await shell.rows();
  }
}

afterEach(resetInkTtyState);

describe("ApprovalOptions frame", () => {
  test("offers Yes, the always option and the custom denial, caret on the first", async () => {
    const { shell } = await mountApprovalOptions();
    try {
      expect(await shell.rows()).toEqual([
        "",
        "❯ 1. Yes",
        "  2. Always allow",
        "  3. No, and tell Haruyuki what to do differently",
        "",
        "Enter to select · Esc to cancel",
      ]);
    } finally {
      shell.stop();
    }
  });

  test("without persistence the always option is gone and the custom row is 2", async () => {
    const { shell } = await mountApprovalOptions({ allowPersistence: false });
    try {
      expect(await shell.rows()).toEqual([
        "",
        "❯ 1. Yes",
        "  2. No, and tell Haruyuki what to do differently",
        "",
        "Enter to select · Esc to cancel",
      ]);
    } finally {
      shell.stop();
    }
  });

  test("the caret walks down to the custom row and its hint changes", async () => {
    const { shell } = await mountApprovalOptions();
    try {
      await pressKeys(shell, [DOWN, DOWN]);
      const rows = await shell.rows();
      expect(rows).toContain(
        "❯ 3. No, and tell Haruyuki what to do differently█",
      );
      expect(rows).toContain("Type reason · Esc to cancel");
    } finally {
      shell.stop();
    }
  });
});

describe("ApprovalOptions keys", () => {
  const table: { name: string; keys: string[]; expected: string[] }[] = [
    { name: "Enter on Yes approves", keys: [ENTER], expected: ["approve"] },
    { name: "1 approves", keys: ["1"], expected: ["approve"] },
    { name: "2 approves always", keys: ["2"], expected: ["always"] },
    { name: "Escape cancels", keys: [ESC], expected: ["cancel"] },
    { name: "Ctrl+C cancels", keys: [CTRL_C], expected: ["cancel"] },
  ];

  for (const { name, keys, expected } of table) {
    test(name, async () => {
      const { shell, actions } = await mountApprovalOptions();
      try {
        await pressKeys(shell, keys);
        expect(actions).toEqual(expected);
      } finally {
        shell.stop();
      }
    });
  }

  test("without persistence there is no always answer to take", async () => {
    const { shell, actions } = await mountApprovalOptions({
      allowPersistence: false,
    });
    try {
      await pressKeys(shell, ["2"]);
      expect(actions).toEqual([]);
    } finally {
      shell.stop();
    }
  });

  test("an unfocused list takes no keys at all", async () => {
    const { shell, actions } = await mountApprovalOptions({ isFocused: false });
    try {
      await pressKeys(shell, [ENTER, "1", "2", CTRL_C, DOWN]);
      expect(actions).toEqual([]);
    } finally {
      shell.stop();
    }
  });
});
