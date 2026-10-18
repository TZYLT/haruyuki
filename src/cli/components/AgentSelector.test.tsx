import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_DESKTOP_FAVORITE_TAG } from "@/agent/favorites";
import {
  LOCAL_BACKEND_DIR_ENV,
  LOCAL_BACKEND_EXPERIMENTAL_ENV,
} from "@/backend/local/paths";
import { settingsManager } from "@/settings-manager";
import {
  type InkTty,
  mountInkTty,
  resetInkTtyState,
} from "@/test-utils/ink-tty";
import { setServiceName } from "@/utils/secrets";
import { AgentSelector } from "./AgentSelector";

/**
 * `/agents` on the overlay toolkit — this face's first test.
 *
 * The face has two screens and two lists, so these assert on the frame: which
 * screen is on the glass, which row the marker is on, and which callback a key
 * reached. The fixture is a real local-backend directory
 * (`LETTA_LOCAL_BACKEND_DIR`) with two agents on disk, one of them tagged as a
 * Desktop favourite — that tag is the whole difference between the Pinned and
 * Local tabs, so both lists have rows here.
 *
 * The delete confirmation is exercised end to end, including the positive path:
 * Enter on a matching name really deletes the record. That rule ("a name that
 * does not match makes Enter a no-op") was left open for this batch by
 * `docs/37` §9D.3.
 */

const ESC = "\u001b";
const ENTER = "\r";
const CTRL_C = "\u0003";
const DOWN = "\u001b[B";
const TAB = "\t";
const END = "\u001b[F";
const HOME = "\u001b[H";

const COLUMNS = 100;
const SOLID = "─".repeat(COLUMNS);

const ALPHA = "agent-local-alpha";
const BETA = "agent-local-beta";

const PINNED_TABS = "  Pinned    Local    New";
const PINNED_HINT =
  "  Enter select · ↑↓ ←→ navigate · Tab switch · Shift+D delete · Shift+P unpin · Esc cancel";
const LOCAL_HINT =
  "  Enter select · ↑↓ ←→ navigate · Tab switch · Shift+D delete · Esc cancel";

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Keys 60 ms apart, and a settle after the run. The harness's own 30 ms spacing
 * is enough for one key, but a *run* can land twice — the router's raw path and
 * Ink's fallback both read one dispatch (`docs/37` §9J.2 item 9).
 */
async function press(tty: InkTty, ...keys: string[]): Promise<void> {
  for (const key of keys) {
    await tty.press(key);
    await settle();
  }
}

async function type(tty: InkTty, text: string): Promise<void> {
  for (const char of text) {
    await tty.press(char);
    await settle();
  }
}

/** The first paint of the pinned tab is its loading line; give the load a beat. */
async function settledRows(tty: InkTty): Promise<string[]> {
  await settle(120);
  return tty.rows();
}

let fakeHome: string;
let storageDir: string;
let originalHome: string | undefined;
let originalStorage: string | undefined;

beforeEach(async () => {
  await settingsManager.reset();
  setServiceName("haruyuki-agent-selector-test");
  fakeHome = mkdtempSync(join(tmpdir(), "agent-selector-home-"));
  storageDir = mkdtempSync(join(tmpdir(), "agent-selector-storage-"));
  originalHome = process.env.HOME;
  originalStorage = process.env[LOCAL_BACKEND_DIR_ENV];
  process.env.HOME = fakeHome;
  process.env[LOCAL_BACKEND_DIR_ENV] = storageDir;
  process.env[LOCAL_BACKEND_EXPERIMENTAL_ENV] = "1";
  await settingsManager.initialize();
});

afterEach(async () => {
  await settingsManager.reset();
  process.env.HOME = originalHome;
  if (originalStorage === undefined) {
    delete process.env[LOCAL_BACKEND_DIR_ENV];
  } else {
    process.env[LOCAL_BACKEND_DIR_ENV] = originalStorage;
  }
  delete process.env[LOCAL_BACKEND_EXPERIMENTAL_ENV];
  setServiceName("letta-code");
  resetInkTtyState();
  for (const dir of [fakeHome, storageDir]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Disposable either way.
    }
  }
});

function agentRecordPath(id: string): string {
  return join(
    storageDir,
    "agents",
    `${Buffer.from(id).toString("base64url")}.json`,
  );
}

function agentRecord(
  id: string,
  name: string,
  fields: Record<string, unknown> = {},
): void {
  const agentsDir = join(storageDir, "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    agentRecordPath(id),
    JSON.stringify({
      id,
      name,
      description: null,
      system: "",
      tags: [],
      model: "local/default",
      model_settings: {},
      ...fields,
    }),
  );
}

/** One favourite (the Pinned tab) plus one plain local agent. */
function seedAgents(): void {
  agentRecord(ALPHA, "Alpha", { tags: [LOCAL_DESKTOP_FAVORITE_TAG] });
  agentRecord(BETA, "Beta", { description: "Second agent" });
}

interface Harness {
  tty: InkTty;
  selected: string[];
  closes: string[];
  created: string[];
}

function mount(currentAgentId = "agent-local-other"): Harness {
  const selected: string[] = [];
  const closes: string[] = [];
  const created: string[] = [];
  const tty = mountInkTty(
    <AgentSelector
      currentAgentId={currentAgentId}
      onSelect={(id, backendMode) => selected.push(`${id}:${backendMode}`)}
      onCancel={() => closes.push("close")}
      onCreateNewAgent={(name, backendMode) =>
        created.push(`${name}:${backendMode}`)
      }
    />,
    { columns: COLUMNS, rows: 40 },
  );
  return { tty, selected, closes, created };
}

/** The four lines the frame owns above whatever the tab paints. */
function head(): string[] {
  return ["> /agents", SOLID, "", "Swap to a different agent", ""];
}

describe("AgentSelector", () => {
  test("paints the pinned favourite and the footer that goes with it", async () => {
    seedAgents();
    const { tty } = mount();
    try {
      expect(await settledRows(tty)).toEqual([
        ...head(),
        PINNED_TABS,
        "  Save agents for easy access with /pin or Desktop favorites",
        "",
        "> Alpha · agent-local-alpha",
        "  No description",
        "  Just now",
        "",
        "",
        "  Page 1/1",
        PINNED_HINT,
      ]);
    } finally {
      tty.stop();
    }
  });

  test("the Local tab lists the local agents, the current one first", async () => {
    seedAgents();
    const { tty } = mount(ALPHA);
    try {
      await settledRows(tty);
      await press(tty, TAB);
      expect(await tty.rows()).toEqual([
        ...head(),
        PINNED_TABS,
        "  Local agents from this device",
        "",
        "> Alpha · Local · agent-local-alpha (current)",
        "  No description",
        "  Just now",
        "",
        "  Beta · Local · agent-local-beta",
        "  Second agent",
        "  Just now",
        "",
        "",
        "  Page 1/1",
        LOCAL_HINT,
      ]);
    } finally {
      tty.stop();
    }
  });

  test("↓ moves the marker and Enter selects the row it is on", async () => {
    seedAgents();
    const { tty, selected } = mount(ALPHA);
    try {
      await settledRows(tty);
      await press(tty, TAB, DOWN);
      const rows = await tty.rows();
      expect(rows[8]).toBe("  Alpha · Local · agent-local-alpha (current)");
      expect(rows[12]).toBe("> Beta · Local · agent-local-beta");

      await press(tty, ENTER);
      expect(selected).toEqual([`${BETA}:local`]);
    } finally {
      tty.stop();
    }
  });

  test("End and Home jump within the page, which is the whole list here", async () => {
    seedAgents();
    const { tty } = mount(ALPHA);
    try {
      await settledRows(tty);
      await press(tty, TAB);
      await press(tty, END);
      expect((await tty.rows())[12]).toBe("> Beta · Local · agent-local-beta");
      await press(tty, HOME);
      expect((await tty.rows())[8]).toBe(
        "> Alpha · Local · agent-local-alpha (current)",
      );
    } finally {
      tty.stop();
    }
  });

  test("Shift+D opens the confirmation, and Escape goes back to the list", async () => {
    seedAgents();
    const { tty, closes } = mount();
    try {
      await settledRows(tty);
      await press(tty, "D");
      expect(await tty.rows()).toEqual([
        "> /agents",
        SOLID,
        "",
        "Delete agent",
        "",
        "  Are you sure you want to delete Alpha?",
        "  This action can not be undone.",
        "",
        "> (type the agent's name)",
        "",
        "  Esc cancel",
      ]);

      await press(tty, ESC);
      expect(closes).toEqual([]);
      expect((await tty.rows())[3]).toBe("Swap to a different agent");
      expect(existsSync(agentRecordPath(ALPHA))).toBe(true);
    } finally {
      tty.stop();
    }
  });

  test("a lowercase d is not the delete key", async () => {
    seedAgents();
    const { tty } = mount();
    try {
      await settledRows(tty);
      await press(tty, "d");
      expect((await tty.rows())[3]).toBe("Swap to a different agent");
      // The frame alone would also pass if `d` deleted outright and the list then
      // re-rendered, so the record is the assertion that matters.
      expect(existsSync(agentRecordPath(ALPHA))).toBe(true);
    } finally {
      tty.stop();
    }
  });

  test("a lowercase p is not the unpin key, and Shift+P unpins", async () => {
    seedAgents();
    const { tty } = mount();
    try {
      await settledRows(tty);
      // Alpha is the favourited (pinned) row, and the footer says `Shift+P unpin`.
      await press(tty, "p");
      expect((await tty.rows()).join("\n")).toContain(
        "Alpha · agent-local-alpha",
      );

      await press(tty, "P");
      await settle(200);
      expect(await tty.rows()).toEqual([
        ...head(),
        PINNED_TABS,
        "  Save agents for easy access with /pin or Desktop favorites",
        "",
        "  No pinned or favorite agents, use /pin to save",
        "",
        "  Tab switch · Esc cancel",
      ]);
    } finally {
      tty.stop();
    }
  });

  test("Ctrl+C closes the selector from inside the confirmation", async () => {
    seedAgents();
    const { tty, closes } = mount();
    try {
      await settledRows(tty);
      await press(tty, "D", CTRL_C);
      expect(closes).toEqual(["close"]);
    } finally {
      tty.stop();
    }
  });

  test("Enter is a no-op while the typed name does not match", async () => {
    seedAgents();
    const { tty } = mount();
    try {
      await settledRows(tty);
      await press(tty, "D");
      await type(tty, "Alph");
      await press(tty, ENTER);
      expect((await tty.rows())[3]).toBe("Delete agent");
      expect(existsSync(agentRecordPath(ALPHA))).toBe(true);
    } finally {
      tty.stop();
    }
  });

  test("the matching name deletes the record and returns to an empty list", async () => {
    seedAgents();
    const { tty } = mount();
    try {
      await settledRows(tty);
      await press(tty, "D");
      await type(tty, "Alpha");
      await press(tty, ENTER);
      await settle(200);

      expect(existsSync(agentRecordPath(ALPHA))).toBe(false);
      expect(await tty.rows()).toEqual([
        ...head(),
        PINNED_TABS,
        "  Save agents for easy access with /pin or Desktop favorites",
        "",
        "  No pinned or favorite agents, use /pin to save",
        "",
        "  Tab switch · Esc cancel",
      ]);
    } finally {
      tty.stop();
    }
  });

  test("the New tab edits a name, and Escape clears it before it cancels", async () => {
    seedAgents();
    const { tty, closes } = mount();
    try {
      await settledRows(tty);
      await press(tty, "n");
      expect((await tty.rows())[11]).toBe("> Haruyuki");

      await type(tty, "abc");
      expect((await tty.rows())[11]).toBe("> abc");

      await press(tty, ESC);
      expect((await tty.rows())[11]).toBe("> Haruyuki");
      expect(closes).toEqual([]);

      await press(tty, ESC);
      expect(closes).toEqual(["close"]);
    } finally {
      tty.stop();
    }
  });

  test("the New tab creates the agent, or refuses an invalid name", async () => {
    seedAgents();
    const { tty, created } = mount();
    try {
      await settledRows(tty);
      await press(tty, "n");
      await type(tty, "bad/name");
      await press(tty, ENTER);
      expect(created).toEqual([]);
      expect(
        (await tty.text()).includes("Name contains invalid characters"),
      ).toBe(true);

      await type(tty, "\u007f".repeat("bad/name".length));
      await type(tty, "my-new-agent");
      await press(tty, ENTER);
      expect(created).toEqual([`my-new-agent:local`]);
    } finally {
      tty.stop();
    }
  });
});
