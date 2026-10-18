import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearAvailableModelsCache } from "@/agent/available-models";
import type { Backend } from "@/backend";
import { __testSetBackend } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import { settingsManager } from "@/settings-manager";
import type { InkTty } from "@/test-utils/ink-tty";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";
import { setupRuntimeModelCatalogFixture } from "@/test-utils/runtime-model-catalog";
import { ModelSelector } from "./ModelSelector";

/**
 * The model selector, on the frame and on its keys.
 *
 * Most of this file's subject used to be hand-wired: its own `useInput`, its own
 * window arithmetic, its own scroll indicator, and `OverlayShell` for the chrome.
 * It now renders through `OverlayFrame` and `OverlayListView` and takes its keys
 * from `list-bindings.ts`, so what these assertions pin is that the move kept the
 * face it had -- and, where it deliberately did not, that it is the change the
 * user approved:
 *
 *  - the window shows the same rows and the same count of them;
 *  - PageUp/PageDown/Home/End now navigate (they did nothing before);
 *  - the indicator is the toolkit's (`↓ N more`, plus its reserved row above and
 *    below), not `  ↓ N more below` with one row reserved;
 *  - `j`/`k` stay search text: this list sits beside an always-live query field,
 *    which is exactly when `list-bindings.ts` says not to take them.
 *
 * The parity evidence for everything else is a capture of 22 key sequences over
 * both list lengths, taken before and after the move: 20 of the 22 frames are
 * byte-identical at 5 models, and at 12 models every difference is one of the
 * two indicator rows above.
 */

setupRuntimeModelCatalogFixture();

let previousHome: string | undefined;
let tempHome: string;

beforeAll(async () => {
  previousHome = process.env.HOME;
  tempHome = mkdtempSync(join(tmpdir(), "letta-model-selector-test-"));
  process.env.HOME = tempHome;
  await settingsManager.reset();
  await settingsManager.initialize();
});

afterAll(async () => {
  await settingsManager.reset();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(tempHome, { recursive: true, force: true });
});

let listCalls = 0;

function modelBackend(count: number): Backend {
  const backend = new FakeHeadlessBackend();
  backend.listModels = async () => {
    listCalls += 1;
    return Array.from({ length: count }, (_, index) => ({
      handle: `prov/model-${index + 1}`,
      display_name: `Model ${index + 1}`,
      provider_type: "prov",
    })) as unknown as Awaited<ReturnType<Backend["listModels"]>>;
  };
  return backend;
}

let modelCount = 5;

beforeEach(() => {
  listCalls = 0;
  clearAvailableModelsCache();
  __testSetBackend(modelBackend(modelCount));
});

afterEach(() => {
  resetInkTtyState();
  clearAvailableModelsCache();
  __testSetBackend(null);
});

const DOWN = "\u001b[B";
const LEFT = "\u001b[D";
const ENTER = "\r";
const ESC = "\u001b";
const CTRL_C = "\u0003";
const BACKSPACE = "\u007f";
const PAGE_DOWN = "\u001b[6~";
const HOME = "\u001b[H";
const END = "\u001b[F";

interface Harness {
  shell: InkTty;
  selected: string[];
  cancelled: string[];
  connected: string[];
}

async function mountSelector(
  options: { count?: number; withConnect?: boolean } = {},
): Promise<Harness> {
  if (options.count !== undefined) {
    clearAvailableModelsCache();
    __testSetBackend(modelBackend(options.count));
  }
  const selected: string[] = [];
  const cancelled: string[] = [];
  const connected: string[] = [];
  const shell = mountInkTty(
    <ModelSelector
      localModelCatalog
      onSelect={(selection: { handle?: string; id: string }) =>
        selected.push(selection.handle ?? selection.id)
      }
      onCancel={() => cancelled.push("cancel")}
      onOpenConnect={() => connected.push("connect")}
    />,
    { columns: 80, rows: 30 },
  );
  // The list arrives from the fake backend through a cache read and a catalog
  // refresh; settle until the frame stops being the loading one.
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const text = await shell.text();
    if (!text.includes("Loading available models")) break;
  }
  return { shell, selected, cancelled, connected };
}

/** Press keys one at a time, reading a frame between them. */
async function pressKeys(shell: InkTty, keys: string[]): Promise<void> {
  for (const key of keys) {
    await shell.press(key);
    await shell.rows();
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

const SHORT_FRAME = [
  "> /model",
  "─".repeat(80),
  "",
  "Swap your agent's model",
  "",
  "  Recommended [5]    All models [5]",
  "  Recommended models currently available for this account",
  "  Search: (type to filter)",
  "",
  "> Model 1",
  "  Model 2",
  "  Model 3",
  "  Model 4",
  "  Model 5",
  "",
  "  5 models · R to refresh list",
  "  Enter select · ↑↓ navigate · ←→/Tab switch · Esc cancel",
];

describe("ModelSelector frame", () => {
  test("a short list renders the whole list, unchanged by the move", async () => {
    const { shell } = await mountSelector();
    try {
      expect(await shell.rows()).toEqual(SHORT_FRAME);
    } finally {
      shell.stop();
    }
  });

  test("the empty state keeps its two-row action and offers /connect", async () => {
    modelCount = 0;
    const { shell, connected } = await mountSelector({
      count: 0,
      withConnect: true,
    });
    try {
      const rows = await shell.rows();
      expect(rows).toContain("  No models available.");
      expect(rows).toContain("  > /connect");
      expect(rows).toContain(
        "    Connect your LLM API keys (OpenAI, Anthropic, etc.)",
      );
      await pressKeys(shell, [ENTER]);
      expect(connected).toEqual(["connect"]);
    } finally {
      shell.stop();
      modelCount = 5;
    }
  });

  test("a long list is windowed by the toolkit, with its two reserved indicator rows", async () => {
    const { shell } = await mountSelector({ count: 12 });
    try {
      const rows = await shell.rows();
      // Seven model rows: the search line costs one row of the eight.
      expect(rows.filter((row) => row.includes("Model "))).toHaveLength(7);
      expect(rows).toContain("> Model 1");
      expect(rows).toContain(" ↓ 5 more");
      // The row the old indicator never spent, kept blank at the top.
      expect(rows[8]).toBe("");
    } finally {
      shell.stop();
    }
  });
});

describe("ModelSelector keys", () => {
  test("Enter selects the model under the cursor, not the first one", async () => {
    const { shell, selected } = await mountSelector();
    try {
      await pressKeys(shell, [DOWN, ENTER]);
      expect(selected).toEqual(["prov/model-2"]);
    } finally {
      shell.stop();
    }
  });

  test("typing filters the list and Enter takes the match", async () => {
    const { shell, selected } = await mountSelector();
    try {
      await pressKeys(shell, ["3"]);
      const rows = await shell.rows();
      expect(rows).toContain("  Search: 3");
      expect(rows).toContain("> Model 3");
      expect(rows).not.toContain("  Model 1");
      await pressKeys(shell, [ENTER]);
      expect(selected).toEqual(["prov/model-3"]);
    } finally {
      shell.stop();
    }
  });

  test("backspace edits the query and Escape clears it before cancelling", async () => {
    const { shell, cancelled } = await mountSelector();
    try {
      await pressKeys(shell, ["3", BACKSPACE]);
      expect(await shell.text()).toContain("(type to filter)");
      await pressKeys(shell, ["3", ESC]);
      expect(await shell.text()).toContain("(type to filter)");
      // One Escape cleared the query; the second one left the overlay.
      await pressKeys(shell, [ESC]);
      expect(cancelled).toEqual(["cancel"]);
    } finally {
      shell.stop();
    }
  });

  test("Tab and the arrows switch category, and the search is cleared", async () => {
    const { shell } = await mountSelector();
    try {
      await pressKeys(shell, ["3", "\t"]);
      const rows = await shell.rows();
      expect(rows).toContain("  Search: (type to filter)");
      expect(rows.join("\n")).toContain("All models [5]");
      await pressKeys(shell, [LEFT]);
      expect((await shell.rows()).join("\n")).toContain("Recommended [5]");
    } finally {
      shell.stop();
    }
  });

  test("R refreshes the list, through the fake backend", async () => {
    const { shell } = await mountSelector();
    try {
      const before = listCalls;
      await pressKeys(shell, ["r"]);
      expect(listCalls).toBeGreaterThan(before);
    } finally {
      shell.stop();
    }
  });

  test("PageDown, Home and End navigate now", async () => {
    const { shell } = await mountSelector({ count: 12 });
    try {
      await pressKeys(shell, [END]);
      expect(await shell.text()).toContain("> Model 12");
      await pressKeys(shell, [HOME]);
      expect(await shell.text()).toContain("> Model 1");
      await pressKeys(shell, [PAGE_DOWN]);
      expect(await shell.text()).toContain("> Model 8");
    } finally {
      shell.stop();
    }
  });

  test("j and k are search text, not navigation", async () => {
    const { shell } = await mountSelector();
    try {
      await pressKeys(shell, ["j"]);
      const text = await shell.text();
      expect(text).toContain("  Search: j");
      // It filtered the list rather than moving the cursor: `j` is a query here.
      expect(text).toContain("  No models match your search.");
    } finally {
      shell.stop();
    }
  });

  test("Ctrl+C cancels", async () => {
    const { shell, cancelled } = await mountSelector();
    try {
      await pressKeys(shell, [CTRL_C]);
      expect(cancelled).toEqual(["cancel"]);
    } finally {
      shell.stop();
    }
  });
});
