import { afterEach, describe, expect, test } from "bun:test";
import {
  type StaticSubagent,
  SubagentGroupStatic,
} from "@/cli/components/SubagentGroupStatic";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";
import { setupRuntimeModelCatalogFixture } from "@/test-utils/runtime-model-catalog";

/**
 * The frozen subagent group, judged on the frame.
 *
 * These rows are the pre-batch pixels. `SubagentGroupStatic` and
 * `SubagentGroupDisplay` each carried their own copy of the row markup until this
 * batch extracted `SubagentRow.tsx`; the shared row was then proven row-for-row
 * identical against the checked-out pre-batch components across 22 states, on the
 * raw frame bytes (colours included, which the plain text projection drops). What
 * is pinned here is the outcome of that proof, so a later edit that moves a cell
 * fails even though the pre-batch component is gone.
 *
 * The labels come from the runtime model catalog fixture: they are not stable
 * across catalog states ("haiku" renders as `haiku` with none installed), and a
 * golden row that depended on whichever test ran first would be worse than none.
 */

setupRuntimeModelCatalogFixture();

afterEach(resetInkTtyState);

const COLUMNS = 100;

function staticAgent(
  overrides: Partial<StaticSubagent> & { id: string },
): StaticSubagent {
  return {
    type: "Recall",
    description: "Look up the docs",
    status: "completed",
    toolCount: 0,
    totalTokens: 0,
    agentURL: null,
    ...overrides,
  };
}

async function rowsOf(agents: StaticSubagent[]): Promise<string[]> {
  const tty = mountInkTty(<SubagentGroupStatic agents={agents} />, {
    columns: COLUMNS,
    rows: 60,
  });
  try {
    return await tty.rows();
  } finally {
    tty.stop();
  }
}

describe("SubagentGroupStatic", () => {
  test("paints the group header, the agent row and its stats", async () => {
    expect(
      await rowsOf([
        staticAgent({
          id: "a1",
          toolCount: 3,
          totalTokens: 4321,
          model: "lc-anthropic/claude-haiku-4-5",
        }),
      ]),
    ).toEqual([
      "• Ran 1 agent",
      "  └─ Look up the docs · recall · Haiku 4.5 ▲ · 3 tool uses · 4.3k tokens",
      "       Done",
    ]);
  });

  test("counts a single tool use in the singular and omits empty tokens", async () => {
    expect(await rowsOf([staticAgent({ id: "a1", toolCount: 1 })])).toEqual([
      "• Ran 1 agent",
      "  └─ Look up the docs · recall · 1 tool use",
      "       Done",
    ]);
  });

  test("shows an error's message instead of a status word", async () => {
    expect(
      await rowsOf([
        staticAgent({ id: "a1", status: "error", error: "provider exploded" }),
      ]),
    ).toEqual([
      "• Ran 1 agent",
      "  └─ Look up the docs · recall · 0 tool uses",
      "       provider exploded",
    ]);
  });

  test("a background agent links its agent url and says it is still running", async () => {
    expect(
      await rowsOf([
        staticAgent({
          id: "a1",
          description: "Background work",
          status: "running",
          toolCount: 2,
          totalTokens: 99,
          agentURL: "https://app.letta.com/agents/agent-456",
          isBackground: true,
        }),
      ]),
    ).toEqual([
      "• Running 1 agent",
      "  └─ Background work · recall",
      "     └ Subagent: https://app.letta.com/agents/agent-456",
      "       Running in the background",
    ]);
  });

  test("a background agent with no url paints no status line at all", async () => {
    expect(
      await rowsOf([
        staticAgent({
          id: "a1",
          description: "Background work",
          status: "running",
          isBackground: true,
        }),
      ]),
    ).toEqual(["• Running 1 agent", "  └─ Background work · recall"]);
  });

  test("the tree characters follow each agent's position in the group", async () => {
    expect(
      await rowsOf([
        staticAgent({
          id: "a1",
          description: "First",
          toolCount: 2,
          totalTokens: 100,
        }),
        staticAgent({
          id: "a2",
          type: "Code-reviewer",
          description: "Second",
          status: "error",
          toolCount: 1,
          agentURL: "https://app.letta.com/agents/agent-000",
          error: "boom",
        }),
      ]),
    ).toEqual([
      "• Ran 2 agents",
      "  ├─ First · recall · 2 tool uses · 100 tokens",
      "  │    Done",
      "  └─ Second · code-reviewer · 1 tool use",
      "     └ Subagent: https://app.letta.com/agents/agent-000",
      "       boom",
    ]);
  });

  test("paints nothing when the group is empty", async () => {
    const tty = mountInkTty(<SubagentGroupStatic agents={[]} />, {
      columns: COLUMNS,
    });
    try {
      expect(await tty.text()).toBe("");
    } finally {
      tty.stop();
    }
  });
});
