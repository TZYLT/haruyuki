import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { McpServerConfig } from "@/mcp-client";
import { settingsManager } from "@/settings-manager";
import {
  type InkTty,
  mountInkTty,
  resetInkTtyState,
} from "@/test-utils/ink-tty";
import { buildMcpRows, McpSelector } from "./McpSelector";

/**
 * `/mcp`, which had no test at all — the gap B4's ledger left for this batch.
 *
 * The servers are configured as commands that do not exist, which is enough to
 * make the runtime produce a *failed* row for each of them without spawning a
 * real MCP server: the face then has a populated, cursor-driven list to judge,
 * which is the part that moved onto the toolkit (its own pager became the
 * toolkit's window) and the part the removal confirmation sits on.
 */

const AGENT_ID = "agent-mcp-test";
const ESC = "\u001b";
const ENTER = "\r";
const CTRL_C = "\u0003";
const DOWN = "\u001b[B";
const UP = "\u001b[A";

function server(name: string): McpServerConfig {
  return {
    name,
    transport: "stdio",
    command: "definitely-not-an-installed-binary",
    args: [],
  } as McpServerConfig;
}

beforeEach(async () => {
  // Same singleton rule as the sibling selector tests: reset first, or
  // `initialize()` no-ops against the previous file's settings.
  await settingsManager.reset();
  await settingsManager.initialize();
});

afterEach(async () => {
  settingsManager.setMcpServers(AGENT_ID, []);
  await settingsManager.flush();
  resetInkTtyState();
});

async function mountMcp(options: {
  servers?: string[];
  onAdd?: () => void;
  onCancel?: () => void;
}): Promise<{ tty: InkTty; cancelled: string[]; added: string[] }> {
  settingsManager.setMcpServers(
    AGENT_ID,
    (options.servers ?? []).map((name) => server(name)),
  );
  await settingsManager.flush();

  const cancelled: string[] = [];
  const added: string[] = [];
  const tty = mountInkTty(
    <McpSelector
      agentId={AGENT_ID}
      onAdd={() => {
        added.push("add");
        options.onAdd?.();
      }}
      onCancel={() => {
        cancelled.push("cancel");
        options.onCancel?.();
      }}
    />,
    { columns: 90, rows: 30 },
  );
  return { tty, cancelled, added };
}

/** Wait for the connection pass to land and paint the row it produced. */
async function waitForRow(tty: InkTty, name: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if ((await tty.text()).includes(name)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

async function pressSlowly(tty: InkTty, ...keys: string[]): Promise<void> {
  for (const key of keys) {
    await tty.press(key);
    await settle();
  }
}

describe("buildMcpRows", () => {
  test("one row per client state, keyed by its config", () => {
    const rows = buildMcpRows([
      { status: "failed", config: server("alpha"), tools: [], error: "x" },
    ] as Parameters<typeof buildMcpRows>[0]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state.config.name).toBe("alpha");
  });
});

describe("the empty list", () => {
  test("says so, and A adds a server", async () => {
    const { tty, added } = await mountMcp({});
    try {
      expect(await tty.text()).toContain("No MCP servers configured");
      await pressSlowly(tty, "a");
      expect(added).toEqual(["add"]);
    } finally {
      tty.stop();
    }
  });

  test("Escape and Ctrl+C both close it", async () => {
    const { tty, cancelled } = await mountMcp({});
    try {
      await pressSlowly(tty, ESC);
      expect(cancelled).toEqual(["cancel"]);
      await pressSlowly(tty, CTRL_C);
      expect(cancelled).toEqual(["cancel", "cancel"]);
    } finally {
      tty.stop();
    }
  });
});

describe("a configured server", () => {
  test("is listed and Enter opens its tools view", async () => {
    const { tty, cancelled } = await mountMcp({ servers: ["alpha"] });
    try {
      await waitForRow(tty, "alpha");
      let painted = await tty.text();
      expect(painted).toContain("Local (this machine)");
      expect(painted).toContain("alpha · stdio · failed");

      await pressSlowly(tty, ENTER);
      painted = await tty.text();
      expect(painted).toContain("Tools for alpha");
      expect(painted).toContain("Connection failed:");

      // Back to the list, not out of the overlay.
      await pressSlowly(tty, ESC);
      expect(await tty.text()).toContain("MCP servers for this agent");
      expect(cancelled).toEqual([]);
    } finally {
      tty.stop();
    }
  });

  test("D opens the removal confirmation, and Escape goes back without removing", async () => {
    const { tty, cancelled } = await mountMcp({ servers: ["alpha", "beta"] });
    try {
      await waitForRow(tty, "beta");
      await pressSlowly(tty, DOWN, "D");
      let painted = await tty.text();
      expect(painted).toContain("Remove client-local MCP server?");
      expect(painted).toContain('Remove "beta" and stop its process?');

      await pressSlowly(tty, ESC);
      painted = await tty.text();
      expect(painted).toContain("MCP servers for this agent");
      expect(cancelled).toEqual([]);
      expect(settingsManager.getMcpServers(AGENT_ID)).toHaveLength(2);
    } finally {
      tty.stop();
    }
  });

  test("a bare d does not open the removal confirmation", async () => {
    const { tty } = await mountMcp({ servers: ["alpha", "beta"] });
    try {
      await waitForRow(tty, "beta");
      expect(await tty.text()).toContain("Shift+D remove");
      // `d` is not the remove key: the chord matcher is case-insensitive, so the
      // binding checks the letter itself — the footer has always advertised
      // `Shift+D remove`.
      await pressSlowly(tty, "d");
      expect(await tty.text()).not.toContain("Remove beta");
      expect(await tty.text()).toContain("MCP servers for this agent");
      expect(settingsManager.getMcpServers(AGENT_ID)).toHaveLength(2);
    } finally {
      tty.stop();
    }
  });

  test("Enter on the confirming row removes it", async () => {
    const { tty } = await mountMcp({ servers: ["alpha", "beta"] });
    try {
      await waitForRow(tty, "beta");
      await pressSlowly(tty, DOWN, "D");
      // The cursor starts on "No, cancel"; up is "Yes, remove".
      await pressSlowly(tty, UP, ENTER);
      await settle(200);
      expect(
        settingsManager.getMcpServers(AGENT_ID).map((config) => config.name),
      ).toEqual(["alpha"]);
    } finally {
      tty.stop();
    }
  });

  test("R refreshes from the tools view and returns to the list", async () => {
    const { tty } = await mountMcp({ servers: ["alpha"] });
    try {
      await waitForRow(tty, "alpha");
      await pressSlowly(tty, ENTER);
      expect(await tty.text()).toContain("Tools for alpha");

      await pressSlowly(tty, "r");
      await waitForRow(tty, "alpha · stdio · failed");
      expect(await tty.text()).toContain("MCP servers for this agent");
    } finally {
      tty.stop();
    }
  });
});

describe("a long list", () => {
  test("windows at seven and says what is below", async () => {
    const names = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
    const { tty } = await mountMcp({
      servers: [...names, "golf", "hotel", "india"],
    });
    try {
      await waitForRow(tty, "golf");
      const painted = await tty.text();
      // Seven rows on screen, the eighth and ninth behind the toolkit's count —
      // which replaced this face's own `Page 1/2`.
      expect(painted).toContain("golf");
      expect(painted).not.toContain("hotel");
      expect(painted).not.toContain("india");
      expect(painted).toMatch(/↓ \d+ more/);
      expect(painted).not.toContain("Page 1/");
    } finally {
      tty.stop();
    }
  });
});
