import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  FileAutocompleteItem,
  FileAutocompleteSuggestions,
} from "@/cli/helpers/file-autocomplete";
import { settingsManager } from "@/settings-manager";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";
import { getVersion } from "@/version";
import type { ModCommandAutocompleteItem } from "./types/autocomplete";

/**
 * `InputAssist`, judged on the frame.
 *
 * The component is three lines of dispatch — `@` anywhere, else a leading `/`,
 * else nothing — and it was rendered by the app with no test of its own. The
 * dispatch is what is covered here, not the popups' interiors (their own files
 * own those): which branch paints, that the `/` branch paints the info bar
 * *under* the popup rather than instead of it, and that the branch it did not
 * take stays off the screen.
 *
 * The `@` case needs the provider replaced for the reason
 * `FileAutocomplete.test.tsx` records: `fd` is not on PATH under the redirected
 * test HOME, so the file branch would paint nothing and "the file branch ran"
 * could only be asserted as an absence. This file is registered in
 * `scripts/isolated-unit-tests.json` for the same reason — a Bun module mock is
 * global to its worker.
 *
 * The info bar needs the settings singleton, because it reads
 * `settingsManager.isAgentPinned(agentId)` for the name's hint. That is the
 * documented pattern (`composer-leader.test.tsx`), so this file owns a temp HOME
 * and restores it.
 */

const manifestItems: FileAutocompleteItem[] = [];

mock.module("@/cli/helpers/file-autocomplete", () => ({
  FileAutocompleteProvider: class {
    async getSuggestions(): Promise<FileAutocompleteSuggestions | null> {
      if (manifestItems.length === 0) return null;
      return { items: [...manifestItems], prefix: "@" };
    }
  },
  applyPiFileCompletion: () => ({ value: "stub", cursorPosition: 0 }),
}));

const { InputAssist } = await import("./InputAssist");

let previousHome: string | undefined;
let tempHome: string;

beforeAll(async () => {
  previousHome = process.env.HOME;
  tempHome = mkdtempSync(join(tmpdir(), "letta-input-assist-"));
  process.env.HOME = tempHome;
  await settingsManager.reset();
  await settingsManager.initialize();
});

afterAll(async () => {
  await settingsManager.reset();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(tempHome, { recursive: true, force: true });
  mock.restore();
});

afterEach(resetInkTtyState);

const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));

const ZMOD: Record<string, ModCommandAutocompleteItem> = {
  zmod: { id: "zmod", description: "a mod command", order: 150 },
};

function file(label: string, description?: string): FileAutocompleteItem {
  return { value: `@${label}`, label, description };
}

function setItems(items: FileAutocompleteItem[]): void {
  manifestItems.length = 0;
  manifestItems.push(...items);
}

interface AssistOptions {
  agentId?: string;
  /** Every `onAutocompleteActiveChange` the subtree reported, in order. */
  active?: boolean[];
}

function mountAssist(input: string, options: AssistOptions = {}) {
  return mountInkTty(
    <InputAssist
      currentInput={input}
      cursorPosition={input.length}
      fdPath="fd"
      onFileAutocompleteApply={() => {}}
      onCommandSelect={() => {}}
      onCommandAutocomplete={() => {}}
      onAutocompleteActiveChange={(isActive) => options.active?.push(isActive)}
      agentId={options.agentId}
      agentName="Rin"
      currentModel="claude-x"
      modCommands={ZMOD}
    />,
    { columns: 100, rows: 40 },
  );
}

async function frame(input: string, options: AssistOptions = {}) {
  const tty = mountAssist(input, options);
  try {
    await settle();
    return await tty.rows();
  } finally {
    tty.stop();
  }
}

describe("InputAssist on the frame", () => {
  test("a leading slash paints the popup and the agent info bar under it", async () => {
    expect(await frame("/zmod", { agentId: "agent-1" })).toEqual([
      "  /zmod          a mod command (mod)",
      // The info bar opens with a line of its own so the popup does not sit
      // against the agent summary.
      "",
      "  Rin (type /pin to pin agent) · claude-x",
      "  agent-1 · default conversation",
      `  Haruyuki v${getVersion()} · /feedback · bugs: github.com/TZYLT/haruyuki/issues`,
    ]);
  });

  test("an @ anywhere beats a leading slash", async () => {
    // The rule is `includes("@")`, not "starts with @": a path typed after a
    // command is still a file completion. Under the narrower reading this input
    // takes the slash branch instead, whose popup answers `No matching commands`
    // (the query is the whole `@zmod` token) and whose info bar paints under it.
    setItems([file("README.md", "README.md")]);

    const rows = await frame("/@zmod", { agentId: "agent-1" });

    expect(rows).toEqual([
      "File autocomplete (↑↓ navigate, Tab/Enter select):",
      "  📄 README.md",
    ]);
  });

  test("without an agent the popup stands alone", async () => {
    // The info bar paints nothing until it has an id, so the slash branch is the
    // popup and nothing else -- and no blank line is left behind for an info bar
    // that is not there.
    expect(await frame("/zmod")).toEqual([
      "  /zmod          a mod command (mod)",
    ]);
  });

  test("ordinary text paints nothing and releases the popup's key claim", async () => {
    const active: boolean[] = [];

    expect(await frame("hello", { active })).toEqual([]);
    // Neither branch is on screen, so the composer must be told it may own the
    // keys again: the flag is what stands its own history handler down while a
    // popup is up.
    expect(active).toEqual([false]);
  });
});
