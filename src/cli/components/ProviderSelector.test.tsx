import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearAvailableModelsCache } from "@/agent/available-models";
import { __testSetBackend } from "@/backend";
import {
  type BackendMode,
  resolveBackendMode,
  setConfiguredBackendMode,
} from "@/backend/backend-mode";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import { createOrUpdateLocalProvider } from "@/backend/local/local-provider-auth-store";
import { settingsManager } from "@/settings-manager";
import {
  type InkTty,
  mountInkTty,
  resetInkTtyState,
} from "@/test-utils/ink-tty";
import { ProviderSelector } from "./ProviderSelector";

/**
 * `/connect`'s key paths, judged on the frame.
 *
 * The face was one `useInput` ladder with seven steps in it; it is a wizard
 * (`wizard.tsx`) over a key table now, and what this file pins is the behaviour
 * that moved, not the plumbing: the filter is a live editor the list must not
 * take letters from, Escape clears it before it leaves, a provider's step is a
 * step the trail returns from, the key field masks what is typed into it, and
 * Ctrl+C closes the overlay from anywhere.
 *
 * The last case is the one a wiring test would miss: Home/End are the filter
 * caret's keys, and the filter re-registers *behind* the list's table every time
 * the overlay walks into a provider's step and back — so `edgeKeys: false` on
 * the list is what keeps the two from swapping places mid-session.
 */

const ESC = "\u001b";
const ENTER = "\r";
const CTRL_C = "\u0003";
const HOME = "\u001b[H";
const END = "\u001b[F";

let previousBackendMode: BackendMode;

beforeEach(async () => {
  // `settingsManager` is a global singleton: `initialize()` returns immediately
  // when it is already initialised, so without the reset this file would run
  // against whatever the previous file in the worker left behind (and leave its
  // own state for the next one).
  await settingsManager.reset();
  previousBackendMode = resolveBackendMode();
  setConfiguredBackendMode("local");
  __testSetBackend(new FakeHeadlessBackend());
  await settingsManager.initialize();
});

afterEach(() => {
  clearAvailableModelsCache();
  __testSetBackend(null);
  setConfiguredBackendMode(previousBackendMode);
  resetInkTtyState();
});

interface Mounted {
  tty: InkTty;
  cancels: string[];
}

/**
 * Mount and wait for the list to arrive.
 *
 * The face paints `Loading providers...` until the first connection refresh
 * lands, and every key is inert until then (`isProviderTargetLoading` is what
 * `navigationEnabled` and the filter's focus are gated on) — pressing into that
 * state asserts against a screen that is not the one under test.
 */
async function mountSelector(): Promise<Mounted> {
  const cancels: string[] = [];
  const tty = mountInkTty(
    <ProviderSelector onCancel={() => cancels.push("cancel")} />,
    { columns: 100, rows: 30 },
  );
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if ((await tty.text()).includes("Amazon Bedrock")) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { tty, cancels };
}

/** The row the list's cursor is on — it shares the `> ` prefix with the header. */
function cursorRow(rows: readonly string[]): string {
  return rows.find((row) => row.startsWith("> ") && row !== "> /connect") ?? "";
}

/** Type a filter, one key at a time, the way the terminal delivers it. */
async function typeFilter(tty: InkTty, text: string): Promise<void> {
  for (const char of text) {
    await tty.press(char);
  }
}

/** Let a passive effect's frame land before reading it back. */
const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the provider list", () => {
  test("the filter is a live editor, and a letter the list would navigate on is its text", async () => {
    const { tty } = await mountSelector();
    try {
      // `j`/`k` are the filter's letters here (`vimKeys: false`): before the
      // migration Ink's fan-out gave one press two meanings — it typed the
      // letter *and* moved the cursor.
      await typeFilter(tty, "j");
      let painted = await tty.text();
      expect(painted).toContain("Filter: j");
      // "j" matches nothing in this list, so the empty-filter row is what shows.
      expect(painted).toContain("No providers match your filter.");

      await typeFilter(tty, "avascript");
      painted = await tty.text();
      expect(painted).toContain("Filter: javascript");
    } finally {
      tty.stop();
    }
  });

  test("arrows move the cursor and the window follows the edge", async () => {
    const { tty } = await mountSelector();
    try {
      const first = cursorRow(await tty.rows());
      expect(first).toContain("Amazon Bedrock");

      await tty.press("\u001b[B", "\u001b[B");
      const moved = cursorRow(await tty.rows());
      expect(moved).not.toBe(first);
      expect(moved).toContain("Anthropic");

      // Eight down from the top walks the window off the first provider and
      // keeps the count in the row this face prints itself (`indicators: false`
      // is what stops the toolkit adding its own second copy of that line).
      await tty.press(
        "\u001b[B",
        "\u001b[B",
        "\u001b[B",
        "\u001b[B",
        "\u001b[B",
        "\u001b[B",
      );
      const painted = await tty.text();
      expect(painted).not.toContain("Amazon Bedrock");
      expect(painted).toMatch(/↓ \d+ more below/);
    } finally {
      tty.stop();
    }
  });

  test("Escape clears the filter first and only then cancels", async () => {
    const { tty, cancels } = await mountSelector();
    try {
      await typeFilter(tty, "vertex");
      expect(await tty.text()).toContain("Filter: vertex");

      await tty.press(ESC);
      // The editor syncs an externally cleared value in a passive effect, and
      // Ink throttles its writes, so a read this close records the previous
      // frame even though the list has already unfiltered itself.
      await settle();
      // The filter is gone and the overlay is still up.
      expect((await tty.text()).includes("Filter: (type to filter)")).toBe(
        true,
      );
      expect(cancels).toEqual([]);

      await tty.press(ESC);
      expect(cancels).toEqual(["cancel"]);
    } finally {
      tty.stop();
    }
  });

  test("Ctrl+C cancels from the list", async () => {
    const { tty, cancels } = await mountSelector();
    try {
      await tty.press(CTRL_C);
      expect(cancels).toEqual(["cancel"]);
    } finally {
      tty.stop();
    }
  });
});

describe("a provider's own step", () => {
  test("Enter opens it and Escape walks back to the list", async () => {
    const { tty, cancels } = await mountSelector();
    try {
      await typeFilter(tty, "vertex");
      await tty.press(ENTER);
      let painted = await tty.text();
      expect(painted).toContain("Connect your Google Vertex AI key:");

      await tty.press(ESC);
      painted = await tty.text();
      expect(painted).toContain("Connect your LLM API keys");
      // A step's Escape is a step back, never a cancel.
      expect(cancels).toEqual([]);
    } finally {
      tty.stop();
    }
  });

  test("Ctrl+C cancels from inside the step, where Escape only goes back", async () => {
    const { tty, cancels } = await mountSelector();
    try {
      await typeFilter(tty, "vertex");
      await tty.press(ENTER);
      expect(await tty.text()).toContain("Connect your Google Vertex AI key:");

      await tty.press(CTRL_C);
      expect(cancels).toEqual(["cancel"]);
    } finally {
      tty.stop();
    }
  });

  test("the API key is typed through an editor and painted over", async () => {
    const { tty } = await mountSelector();
    try {
      await typeFilter(tty, "vertex");
      await tty.press(ENTER);

      await typeFilter(tty, "sk-abcdefghijkl");
      const painted = await tty.text();
      // Never the key itself — and not the four-character prefix the
      // hand-rolled row used to show either.
      expect(painted).not.toContain("sk-abcdefghijkl");
      expect(painted).not.toContain("sk-a");
      expect(painted).toContain("*".repeat(14));
    } finally {
      tty.stop();
    }
  });

  test("Escape from a step forgets what was typed into it", async () => {
    const { tty } = await mountSelector();
    try {
      await typeFilter(tty, "vertex");
      await tty.press(ENTER);
      await typeFilter(tty, "sk-partial");
      expect(await tty.text()).toContain("*".repeat(10));

      // Out and back in: the step opens clean, because leaving it clears it.
      await tty.press(ESC);
      await tty.press(ENTER);
      const painted = await tty.text();
      expect(painted).toContain("Connect your Google Vertex AI key:");
      expect(painted).toContain("(enter key)");
      expect(painted).not.toContain("*");
    } finally {
      tty.stop();
    }
  });

  test("a multi-field step walks its fields and shows the hint on the focused one", async () => {
    const { tty } = await mountSelector();
    try {
      await typeFilter(tty, "openai-compatible");
      await tty.press(ENTER);
      let painted = await tty.text();
      expect(painted).toContain("Connect OpenAI-compatible API");
      expect(painted).toContain("API Key (optional): (enter value)");
      // The unfocused row carries no hint, which is what this view always did.
      expect(painted).not.toContain("Base URL: (enter value)");

      // Tab moves to the next field and the hint moves with the cursor.
      await tty.press("\t");
      painted = await tty.text();
      expect(painted).toContain("Base URL: (enter value)");
      expect(painted).not.toContain("API Key (optional): (enter value)");
    } finally {
      tty.stop();
    }
  });
});

describe("a connected provider", () => {
  test("Enter opens the manage step, and its last row returns to the list", async () => {
    await createOrUpdateLocalProvider({
      providerType: "deepseek",
      providerName: "deepseek",
      apiKey: "sk-test",
    });
    const { tty, cancels } = await mountSelector();
    try {
      await typeFilter(tty, "deepseek");
      await tty.press(ENTER);
      let painted = await tty.text();
      expect(painted).toContain("Manage DeepSeek");
      expect(painted).toContain("Disconnect deepseek");

      // The action list ends with the row that manages nothing: Enter on it
      // leaves the step for the list.
      await tty.press("\u001b[B");
      await tty.press(ENTER);
      painted = await tty.text();
      expect(painted).toContain("Connect your LLM API keys");

      // Finishing a step **returns** to the list rather than pushing it: the
      // filter is still in place, so the first Escape clears it and the second
      // cancels the overlay — neither of them reopens the manage step, which is
      // what makes the trail a return stack and not a history of what was shown.
      await tty.press(ESC);
      expect((await tty.text()).includes("Manage DeepSeek")).toBe(false);
      expect(cancels).toEqual([]);

      await tty.press(ESC);
      expect(cancels).toEqual(["cancel"]);
      expect((await tty.text()).includes("Manage DeepSeek")).toBe(false);
    } finally {
      tty.stop();
    }
  });
});

describe("Home and End", () => {
  test("stay the filter's caret, before and after a trip into a step", async () => {
    const { tty } = await mountSelector();
    try {
      // Before: on a freshly mounted overlay the filter registers ahead of the
      // list, so this passes even without `edgeKeys: false`.
      await tty.press(HOME, END);
      expect(cursorRow(await tty.rows())).toContain("Amazon Bedrock");

      // A trip into a provider's step unmounts the filter and remounts it, and
      // the remount registers *behind* the list's table. Without the flag the
      // list would claim Home/End from here on, and End would jump the cursor to
      // the last row.
      await typeFilter(tty, "vertex");
      await tty.press(ENTER, ESC);
      await tty.press(ESC);
      await tty.press(END, HOME);
      expect(cursorRow(await tty.rows())).toContain("Amazon Bedrock");
    } finally {
      tty.stop();
    }
  });
});
