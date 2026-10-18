import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
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
import { ProfileSelectionInline } from "./profile-selection";

/**
 * The first-run profile picker — this face's first test.
 *
 * Four pinned local agents stand in for the four the flow has to choose between:
 * the last-used one first, then three by recency, which is what puts the
 * `View all 4 profiles` row on screen and `Create a new agent` under it. The
 * listing sorts by file mtime, so the fixture pins each mtime instead of
 * trusting the write order of four files in the same millisecond.
 *
 * The frame's top block is the welcome screen, and it prints this checkout's
 * working directory; the assertions start at the first agent row for that
 * reason, which is also where a failure would mean anything.
 */

const ESC = "\u001b";
const ENTER = "\r";
const CTRL_C = "\u0003";
const DOWN = "\u001b[B";

const FAVOURITES = [
  { id: "agent-local-one", name: "One" },
  { id: "agent-local-two", name: "Two" },
  { id: "agent-local-three", name: "Three" },
  { id: "agent-local-four", name: "Four" },
];

/** How many rows this face paints, from its first agent row down. */
const FACE_ROWS = 14;

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

async function press(tty: InkTty, ...keys: string[]): Promise<void> {
  for (const key of keys) {
    await tty.press(key);
    await settle();
  }
}

let fakeHome: string;
let storageDir: string;
let originalHome: string | undefined;
let originalStorage: string | undefined;

beforeEach(async () => {
  await settingsManager.reset();
  setServiceName("haruyuki-profile-selection-test");
  fakeHome = mkdtempSync(join(tmpdir(), "profile-face-home-"));
  storageDir = mkdtempSync(join(tmpdir(), "profile-face-storage-"));
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

function seedFavourite(name: string, ageSeconds: number): void {
  const id = FAVOURITES.find((entry) => entry.name === name)?.id;
  if (!id) throw new Error(`no fixture id for ${name}`);
  const agentsDir = join(storageDir, "agents");
  mkdirSync(agentsDir, { recursive: true });
  const path = join(agentsDir, `${Buffer.from(id).toString("base64url")}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      id,
      name,
      description: null,
      system: "",
      tags: [LOCAL_DESKTOP_FAVORITE_TAG],
      model: "local/default",
      model_settings: {},
    }),
  );
  const when = new Date(Date.now() - ageSeconds * 1000);
  utimesSync(path, when, when);
}

function seedFavourites(): void {
  FAVOURITES.forEach((favourite, index) => {
    seedFavourite(favourite.name, 100 - index * 10);
  });
}

interface Harness {
  tty: InkTty;
  selected: string[];
  created: number;
  exited: number;
}

async function mount(): Promise<Harness> {
  const selected: string[] = [];
  const harness = {
    selected,
    created: 0,
    exited: 0,
  } as Harness;
  harness.tty = mountInkTty(
    <ProfileSelectionInline
      lruAgentId="agent-local-one"
      loading={false}
      onSelect={(id) => selected.push(id)}
      onCreateNew={() => {
        harness.created += 1;
      }}
      onExit={() => {
        harness.exited += 1;
      }}
    />,
    { columns: 80, rows: 40 },
  );
  await settle(200);
  return harness;
}

/** The rows this face owns, starting at the first agent row. */
function faceRows(rows: string[]): string[] {
  const start = rows.findIndex((row) => row.includes("Resume "));
  if (start < 0) throw new Error("the picker painted no agent row");
  return rows.slice(start, start + FACE_ROWS);
}

function optionRows(name: string, marker: string): string[] {
  return [
    `${marker}Resume ${name} (pinned)`,
    "    1 minute ago · 0 memory blocks · default",
    "",
  ];
}

describe("ProfileSelectionInline", () => {
  test("paints the last-used agent, three pinned ones and the two extra rows", async () => {
    seedFavourites();
    const { tty } = await mount();
    try {
      expect(faceRows(await tty.rows())).toEqual([
        "> Resume One (last used)",
        "    1 minute ago · 0 memory blocks · default",
        "",
        ...optionRows("Four", "  "),
        ...optionRows("Three", "  "),
        "  View all 4 profiles",
        "",
        "  Create a new agent (--new)",
        "",
        "  ↑↓ navigate · Enter select · Esc exit",
      ]);
    } finally {
      tty.stop();
    }
  });

  test("↓ moves the marker and Enter selects the row it is on", async () => {
    seedFavourites();
    const { tty, selected } = await mount();
    try {
      await press(tty, DOWN);
      expect(faceRows(await tty.rows())[3]).toBe("> Resume Four (pinned)");

      await press(tty, ENTER);
      expect(selected).toEqual(["agent-local-four"]);
    } finally {
      tty.stop();
    }
  });

  test("Enter on the view-all row expands the list and resets the cursor", async () => {
    // Five rows down is the view-all row: three options, one blank each.
    seedFavourites();
    const { tty, selected } = await mount();
    try {
      await press(tty, DOWN, DOWN, DOWN, ENTER);
      const rows = await tty.rows();
      expect(selected).toEqual([]);
      expect(optionRows("Two", "  ")).toHaveLength(3);

      const painted = rows.join("\n");
      expect(painted).not.toContain("View all");
      expect(painted).toContain("Resume Two (pinned)");
      // The cursor went back to the first row.
      expect(faceRows(rows)[0]).toBe("> Resume One (last used)");
    } finally {
      tty.stop();
    }
  });

  test("Enter on the create row creates, not selects", async () => {
    // One row below the view-all row.
    seedFavourites();
    const harness = await mount();
    try {
      await press(harness.tty, DOWN, DOWN, DOWN, DOWN, ENTER);
      expect(harness.created).toBe(1);
      expect(harness.selected).toEqual([]);
    } finally {
      harness.tty.stop();
    }
  });

  test("Escape and Ctrl+C both exit", async () => {
    seedFavourites();
    const first = await mount();
    try {
      await press(first.tty, ESC);
      expect(first.exited).toBe(1);
    } finally {
      first.tty.stop();
    }

    const second = await mount();
    try {
      await press(second.tty, CTRL_C);
      expect(second.exited).toBe(1);
    } finally {
      second.tty.stop();
    }
  });
});
