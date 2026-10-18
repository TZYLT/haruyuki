import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  addToolCall,
  clearAllSubagents,
  completeSubagent,
  isExpanded,
  registerSubagent,
  toggleExpanded,
  updateSubagent,
} from "@/agent/subagent-state";
import { SubagentGroupDisplay } from "@/cli/components/SubagentGroupDisplay";
import { AnimationProvider } from "@/cli/contexts/AnimationContext";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";
import { setupRuntimeModelCatalogFixture } from "@/test-utils/runtime-model-catalog";

/**
 * The live subagent group, judged on the frame.
 *
 * `SubagentGroupDisplay` reads a module store and owns a keyboard binding, so
 * these cases drive the real store and the real router rather than props. The
 * rows themselves are the pre-batch pixels, proven row-for-row against the
 * checked-out pre-batch component while this batch was in flight (see
 * `SubagentGroupStatic.test.tsx` for how the proof was run and why the catalog
 * fixture is installed).
 *
 * What differs from the frozen group is policy, and that is what the condensed
 * cases pin: with animation off the row keeps the description and the status word
 * and drops the url line, the stats cell and the expanded tool calls — the shape
 * that exists to stop a tall live area from flickering.
 */

setupRuntimeModelCatalogFixture();

const CTRL_G = "\u0007";
const COLUMNS = 100;

beforeEach(() => {
  // The store is module-global and the expanded flag outlives a test.
  clearAllSubagents();
  if (isExpanded()) toggleExpanded();
});

afterEach(() => {
  clearAllSubagents();
  resetInkTtyState();
});

interface MountOptions {
  animate?: boolean;
  rows?: number;
}

function mountDisplay(options: MountOptions = {}) {
  return mountInkTty(
    <AnimationProvider shouldAnimate={options.animate ?? true}>
      <SubagentGroupDisplay />
    </AnimationProvider>,
    { columns: COLUMNS, rows: options.rows ?? 60 },
  );
}

async function seededRows(
  seed: () => void,
  options: MountOptions = {},
): Promise<string[]> {
  seed();
  const tty = mountDisplay(options);
  try {
    return await tty.rows();
  } finally {
    tty.stop();
  }
}

describe("SubagentGroupDisplay", () => {
  test("an agent with no url and no tool call is launching", async () => {
    expect(
      await seededRows(() => {
        registerSubagent("s1", "recall", "Look up the docs");
      }),
    ).toEqual([
      "",
      "• Running 1 agent (ctrl+g to expand)",
      "  └─ Look up the docs · recall",
      "     └ Launching...",
    ]);
  });

  test("a running tool call names the tool, and stats follow the tokens", async () => {
    expect(
      await seededRows(() => {
        registerSubagent("s1", "recall", "Look up the docs");
        addToolCall("s1", "t1", "Read", '{"file_path":"/tmp/a.md","limit":10}');
        updateSubagent("s1", {
          status: "running",
          totalTokens: 12345,
          model: "haiku",
        });
      }),
    ).toEqual([
      "",
      "• Running 1 agent (ctrl+g to expand)",
      "  └─ Look up the docs · recall · Haiku 4.5 · 1 tool use · 12k tokens",
      "       Read",
    ]);
  });

  test("an error shows its message instead of a status word", async () => {
    expect(
      await seededRows(() => {
        registerSubagent("s1", "recall", "Look up the docs");
        completeSubagent("s1", { success: false, error: "provider exploded" });
      }),
    ).toEqual([
      "",
      "• Ran 1 agent (ctrl+g to expand)",
      "  └─ Look up the docs · recall · 0 tool uses",
      "       provider exploded",
    ]);
  });

  test("a background agent with no url paints no status line", async () => {
    expect(
      await seededRows(() => {
        registerSubagent("s1", "recall", "Background work", undefined, true);
        updateSubagent("s1", { status: "running" });
      }),
    ).toEqual([
      "",
      "• Running 1 agent (ctrl+g to expand)",
      "  └─ Background work · recall",
    ]);
  });

  test("the tree characters follow each agent's position in the group", async () => {
    expect(
      await seededRows(() => {
        registerSubagent("s1", "recall", "First");
        completeSubagent("s1", { success: true, totalTokens: 10 });
        registerSubagent("s2", "code-reviewer", "Second");
        updateSubagent("s2", { status: "running", model: "haiku" });
      }),
    ).toEqual([
      "",
      "• Running 2 agents (ctrl+g to expand)",
      "  ├─ First · recall · 0 tool uses · 10 tokens",
      "  │    Done",
      "  └─ Second · code-reviewer · Haiku 4.5",
      "     └ Launching...",
    ]);
  });

  test("silent agents are not painted", async () => {
    const rows = await seededRows(() => {
      registerSubagent("s1", "init", "hidden work", undefined, false, true);
      registerSubagent("s2", "recall", "Look up the docs");
    });
    expect(rows).toContain("• Running 1 agent (ctrl+g to expand)");
    expect(rows.join("\n")).not.toContain("hidden work");
  });

  test("expanded tool calls appear only once Ctrl+G expands the group", async () => {
    registerSubagent("s1", "recall", "Look up the docs");
    addToolCall("s1", "t1", "Read", '{"file_path":"/tmp/a.md","limit":10}');
    addToolCall("s1", "t2", "Grep", "not json at all");
    addToolCall("s1", "t3", "Bash", '{"command":"ls -la"}');
    updateSubagent("s1", { model: "lc-anthropic/claude-haiku-4-5" });
    completeSubagent("s1", { success: true, totalTokens: 4321 });

    const tty = mountDisplay();
    try {
      expect(await tty.rows()).toEqual([
        "",
        "• Ran 1 agent (ctrl+g to expand)",
        "  └─ Look up the docs · recall · Haiku 4.5 ▲ · 3 tool uses · 4.3k tokens",
        "       Done",
      ]);

      await tty.press(CTRL_G);
      expect(await tty.rows()).toEqual([
        "",
        "• Ran 1 agent (ctrl+g to collapse)",
        "  └─ Look up the docs · recall · Haiku 4.5 ▲ · 3 tool uses · 4.3k tokens",
        '        Read(file_path: "/tmp/a.md", limit: "10")',
        "        Grep()",
        '        Bash(command: "ls -la")',
        "       Done",
      ]);

      await tty.press(CTRL_G);
      const collapsed = await tty.rows();
      expect(collapsed).toEqual([
        "",
        "• Ran 1 agent (ctrl+g to expand)",
        "  └─ Look up the docs · recall · Haiku 4.5 ▲ · 3 tool uses · 4.3k tokens",
        "       Done",
      ]);
      expect(collapsed.join("\n")).not.toContain("Read(");
    } finally {
      tty.stop();
    }
  });

  test("condensed mode keeps the status word and drops the tool call", async () => {
    expect(
      await seededRows(
        () => {
          registerSubagent("s1", "recall", "Look up the docs");
          addToolCall("s1", "t1", "Read", '{"file_path":"/tmp/a.md"}');
          updateSubagent("s1", { status: "running", model: "haiku" });
        },
        { animate: false },
      ),
    ).toEqual([
      "",
      "• Running 1 agent (ctrl+g to expand)",
      "  └─ Look up the docs · recall · Haiku 4.5",
      "       Running...",
    ]);
  });

  test("condensed mode drops the agent url line too", async () => {
    expect(
      await seededRows(
        () => {
          registerSubagent("s1", "recall", "Look up the docs");
          updateSubagent("s1", {
            status: "running",
            agentURL: "https://app.letta.com/agents/agent-789",
            model: "chatgpt-plus-pro/gpt-5.2-codex",
          });
        },
        { animate: false },
      ),
    ).toEqual([
      "",
      "• Running 1 agent (ctrl+g to expand)",
      "  └─ Look up the docs · recall · gpt-5.2-codex ▲",
      "       Thinking",
    ]);
  });

  test("paints nothing when every agent is silent or gone", async () => {
    registerSubagent("s1", "init", "hidden work", undefined, false, true);
    const tty = mountDisplay();
    try {
      expect(await tty.text()).toBe("");
    } finally {
      tty.stop();
    }
  });
});
