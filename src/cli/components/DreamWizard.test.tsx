import { afterEach, describe, expect, test } from "bun:test";
import {
  DreamWizard,
  dreamWizardStepCount,
} from "@/cli/components/DreamWizard";
import {
  DREAM_SETTINGS_DEFAULTS,
  type StoredDreamSettings,
} from "@/dream-settings";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";

/**
 * The first-run dream wizard, judged on the frame (F-06 R-5.9.2).
 *
 * Two behaviours are the reason this file exists and neither is visible in a
 * state assertion: **cancel writes nothing**, and **a failed last step keeps
 * every answer**. Both are sequences, so the test walks the real steps through a
 * fake TTY and reads the painted frame after each key.
 */

const ENTER = "\r";
const ESCAPE = "\u001b";
const CTRL_C = "\u0003";

const initial = DREAM_SETTINGS_DEFAULTS;

interface Harness {
  tty: ReturnType<typeof mountInkTty>;
  saves: StoredDreamSettings[];
  /** Agent ids the carrier-task seam was asked for. */
  ensured: string[];
  closes: () => number;
  completions: () => number;
}

const settle = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));

function mount(
  options: {
    save?: (patch: StoredDreamSettings) => void;
    initialSettings?: typeof DREAM_SETTINGS_DEFAULTS;
    /** Injected carrier-task seam; tests never write the real schedule store. */
    ensureTask?: (agentId: string) => unknown;
  } = {},
): Harness {
  const saves: StoredDreamSettings[] = [];
  const ensured: string[] = [];
  let closes = 0;
  let completions = 0;
  const tty = mountInkTty(
    <DreamWizard
      agentId="agent-dream"
      initialSettings={options.initialSettings ?? initial}
      saveSettings={(patch) => {
        if (options.save) options.save(patch);
        saves.push(patch);
      }}
      ensureTask={(agentId) => {
        if (options.ensureTask) return options.ensureTask(agentId);
        ensured.push(agentId);
        return {};
      }}
      onClose={() => {
        closes += 1;
      }}
      onCompleted={() => {
        completions += 1;
      }}
    />,
    { columns: 80, rows: 30 },
  );
  return {
    tty,
    saves,
    ensured,
    closes: () => closes,
    completions: () => completions,
  };
}

async function painted(tty: ReturnType<typeof mountInkTty>): Promise<string> {
  await settle();
  return (await tty.rows()).join("\n");
}

/** Walk permission → windows → silence → budget (Enter on each). */
async function walkToBudget(
  tty: ReturnType<typeof mountInkTty>,
): Promise<void> {
  await tty.press(ENTER, ENTER, ENTER);
  await settle();
}

afterEach(() => {
  resetInkTtyState();
});

describe("the dream setup wizard", () => {
  test("opens on the permission question and counts four steps", async () => {
    expect(dreamWizardStepCount()).toBe(4);
    const { tty } = mount();
    try {
      const frame = await painted(tty);
      expect(frame).toContain("> /dream on");
      expect(frame).toContain("1/4 Permission");
      expect(frame).toContain("read-write (acceptEdits)");
      expect(frame).toContain("Esc cancel");
    } finally {
      tty.stop();
    }
  });

  test("asks permission, windows, silence and budget, then saves them together", async () => {
    const { tty, saves, ensured, completions } = mount();
    try {
      await painted(tty);
      // Permission: the cursor starts on the current tier (acceptEdits).
      await tty.press(ENTER);
      expect(await painted(tty)).toContain("2/4 Idle windows");
      expect(await tty.text()).toContain("22:00-07:00");
      await tty.press(ENTER);
      expect(await painted(tty)).toContain("3/4 Silence");
      await tty.press(ENTER);
      expect(await painted(tty)).toContain("4/4 Budget");
      await tty.press(ENTER);
      await settle();

      expect(saves).toEqual([
        {
          enabled: true,
          permissionMode: "acceptEdits",
          idleWindows: [{ start: "22:00", end: "07:00" }],
          silenceMinutes: 30,
          maxPerRun: 100_000,
        },
      ]);
      // The explicit enable also creates the carrier task a listener-only host
      // needs (F-06 M1).
      expect(ensured).toEqual(["agent-dream"]);
      expect(completions()).toBe(1);
    } finally {
      tty.stop();
    }
  });

  test("a carrier-task failure keeps the wizard up and Enter retries", async () => {
    let attempts = 0;
    const { tty, saves, completions } = mount({
      ensureTask: (agentId) => {
        attempts += 1;
        if (attempts === 1) throw new Error("schedule store is read-only");
        return { agentId };
      },
    });
    try {
      await painted(tty);
      await walkToBudget(tty);
      await tty.press(ENTER);
      const failed = await painted(tty);
      expect(failed).toContain("4/4 Budget");
      expect(failed).toContain(
        "Saved, but the dream task could not be created: schedule store is read-only",
      );
      // The settings were saved; only the carrier task is missing.
      expect(saves.length).toBe(1);
      expect(completions()).toBe(0);

      await tty.press(ENTER);
      await settle();
      expect(attempts).toBe(2);
      expect(completions()).toBe(1);
    } finally {
      tty.stop();
    }
  });

  test("a malformed window list stays on its step and says why", async () => {
    const { tty } = mount();
    try {
      await painted(tty);
      await tty.press(ENTER);
      await painted(tty);
      // The editor appends at the caret; the result is no longer a valid window.
      await tty.press("x");
      await tty.press(ENTER);
      const frame = await painted(tty);
      expect(frame).toContain("2/4 Idle windows");
      expect(frame).toContain("Use HH:MM-HH:MM pairs, comma separated.");
    } finally {
      tty.stop();
    }
  });

  test("Escape goes back one step, and cancel at the root writes nothing", async () => {
    const { tty, saves, closes } = mount();
    try {
      await painted(tty);
      await tty.press(ENTER);
      await painted(tty);
      expect(await tty.text()).toContain("2/4 Idle windows");

      await tty.press(ESCAPE);
      expect(await painted(tty)).toContain("1/4 Permission");
      expect(closes()).toBe(0);

      await tty.press(ESCAPE);
      expect(closes()).toBe(1);
      expect(saves).toEqual([]);
    } finally {
      tty.stop();
    }
  });

  test("ctrl+c cancels from any step without writing", async () => {
    const { tty, saves, closes } = mount();
    try {
      await painted(tty);
      await tty.press(ENTER);
      await painted(tty);
      await tty.press(CTRL_C);
      expect(closes()).toBe(1);
      expect(saves).toEqual([]);
    } finally {
      tty.stop();
    }
  });

  test("a failed save keeps every answer and stays on the budget step", async () => {
    const { tty, closes, completions } = mount({
      save: () => {
        throw new Error("settings file is busy");
      },
    });
    try {
      await painted(tty);
      await walkToBudget(tty);
      expect(await tty.text()).toContain("4/4 Budget");
      await tty.press(ENTER);
      const failed = await painted(tty);
      expect(failed).toContain("4/4 Budget");
      expect(failed).toContain(
        "Could not save dream settings: settings file is busy",
      );
      expect(closes()).toBe(0);
      expect(completions()).toBe(0);

      // Going back proves the earlier answers survived the failure.
      await tty.press(ESCAPE);
      const silence = await painted(tty);
      expect(silence).toContain("3/4 Silence");
      expect(silence).toContain("30");
      await tty.press(ESCAPE);
      expect(await painted(tty)).toContain("22:00-07:00");
    } finally {
      tty.stop();
    }
  });
});
