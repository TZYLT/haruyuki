import { describe, expect, test } from "bun:test";
import type { DreamNote } from "@/agent/dream/dream-notes";
import {
  type DreamCommandDeps,
  type DreamRunCost,
  type DreamRunRow,
  dreamRunStatusLabel,
  formatDreamRunTime,
  formatDreamWindowsInput,
  handleDreamCommand,
  handleDreamSlashCommand,
  isDreamConfigured,
  isDreamRunFailure,
  parseDreamAction,
  parseDreamWindowsInput,
} from "@/cli/commands/dream";
import {
  DREAM_SETTINGS_DEFAULTS,
  type ResolvedDreamSettings,
} from "@/dream-settings";

/**
 * `/dream`'s four entrances, without a terminal or a real settings file.
 *
 * The registry handler and the submit handler share `runDreamAction`, so the
 * behaviour of the group is asserted once with injected readers: the status
 * face paints settings + records + ledger, `/dream run` refuses before the
 * explicit-configuration gate, and the launcher's own refusal is shown in the
 * user's words rather than swallowed.
 */

const AGENT_ID = "agent-dream";

function settings(
  overrides: Partial<ResolvedDreamSettings> = {},
): ResolvedDreamSettings {
  return { ...DREAM_SETTINGS_DEFAULTS, ...overrides };
}

function deps(
  overrides: Partial<Omit<DreamCommandDeps, "agentId">> = {},
): Partial<Omit<DreamCommandDeps, "agentId">> {
  return {
    readSettings: () => settings(),
    isConfigured: () => true,
    writeSettings: () => {},
    readPressure: () => 0,
    readRuns: async () => [],
    readUsage: async () => new Map<string, DreamRunCost>(),
    startRun: async () => ({ started: true, runId: "run-1" }),
    ensureTask: () => ({}),
    now: () => new Date("2026-10-30T20:00:00.000Z"),
    ...overrides,
  };
}

function runRow(overrides: Partial<DreamRunRow> = {}): DreamRunRow {
  return {
    runId: "run-1",
    status: "succeeded",
    triggerSource: "idle",
    startedAt: Date.parse("2026-10-30T18:00:00.000Z"),
    endedAt: Date.parse("2026-10-30T19:00:00.000Z"),
    budgetTokens: 100_000,
    spentTokens: 41_200,
    reportPath: "maintenance/2026-10-30.md",
    handoff: null,
    ...overrides,
  };
}

interface FakeRunner {
  started: Array<{ input: string; output: string }>;
  finished: Array<{ input: string; output: string; success?: boolean }>;
  failed: Array<{ input: string; output: string }>;
  start: (
    input: string,
    output: string,
  ) => {
    id: string;
    input: string;
    update: () => void;
    finish: (output: string, success?: boolean) => void;
    fail: (output: string) => void;
  };
}

function fakeRunner(): FakeRunner {
  const runner: FakeRunner = {
    started: [],
    finished: [],
    failed: [],
    start(input, output) {
      runner.started.push({ input, output });
      return {
        id: `cmd-${runner.started.length}`,
        input,
        update: () => {},
        finish: (result, success) => {
          runner.finished.push({ input, output: result, success });
        },
        fail: (result) => {
          runner.failed.push({ input, output: result });
        },
      };
    },
  };
  return runner;
}

describe("parseDreamAction", () => {
  test("bare /dream and /dream status are the status face", () => {
    expect(parseDreamAction([])).toEqual({ action: { kind: "status" } });
    expect(parseDreamAction(["status"])).toEqual({
      action: { kind: "status" },
    });
  });

  test("the four explicit entrances parse", () => {
    expect(parseDreamAction(["on"])).toEqual({ action: { kind: "on" } });
    expect(parseDreamAction(["off"])).toEqual({ action: { kind: "off" } });
    expect(parseDreamAction(["config"])).toEqual({
      action: { kind: "config" },
    });
    expect(parseDreamAction(["run"])).toEqual({
      action: { kind: "run", budgetOverrideTokens: undefined },
    });
  });

  test("--budget is accepted in both spellings and only as a positive integer", () => {
    expect(parseDreamAction(["run", "--budget", "50000"])).toEqual({
      action: { kind: "run", budgetOverrideTokens: 50_000 },
    });
    expect(parseDreamAction(["run", "--budget=75000"])).toEqual({
      action: { kind: "run", budgetOverrideTokens: 75_000 },
    });
    for (const bad of [
      ["run", "--budget"],
      ["run", "--budget", "0"],
      ["run", "--budget", "-5"],
      ["run", "--budget", "many"],
      ["run", "--unknown"],
    ]) {
      expect(parseDreamAction(bad)).toMatchObject({
        error: expect.stringContaining("/dream run [--budget <tokens>]"),
      });
    }
  });

  test("an unknown subcommand reports the usage line", () => {
    expect(parseDreamAction(["wander"])).toMatchObject({
      error: expect.stringContaining("Usage: /dream"),
    });
  });

  test("the note entrances parse without touching the existing ones", () => {
    expect(parseDreamAction(["note", "tidy", "the", "projects"])).toEqual({
      action: { kind: "note-add", text: "tidy the projects" },
    });
    expect(parseDreamAction(["note", "  spaced  "])).toEqual({
      action: { kind: "note-add", text: "spaced" },
    });
    expect(parseDreamAction(["notes"])).toEqual({
      action: { kind: "note-list" },
    });
    expect(parseDreamAction(["notes", "clear"])).toEqual({
      action: { kind: "notes-clear" },
    });
    expect(parseDreamAction(["note", "remove", "note-1234abcd"])).toEqual({
      action: { kind: "note-remove", id: "note-1234abcd" },
    });
    // `remove` is only reserved in front: a note may mention it.
    expect(parseDreamAction(["note", "do", "not", "remove", "this"])).toEqual({
      action: { kind: "note-add", text: "do not remove this" },
    });
  });

  test("malformed note forms report the usage line", () => {
    for (const bad of [
      ["note"],
      ["note", "   "],
      ["note", "remove"],
      ["notes", "clear", "now"],
      ["notes", "everything"],
    ]) {
      expect(parseDreamAction(bad)).toMatchObject({
        error: expect.stringContaining("Usage: /dream"),
      });
    }
  });

  test("an over-limit note is refused with the limit, not truncated", () => {
    const parsed = parseDreamAction(["note", "x".repeat(2001)]);
    expect(parsed).toMatchObject({
      error: expect.stringContaining("2000"),
    });
  });
});

describe("the status face", () => {
  test("paints settings, the next-run gap, the last run and its ledger cost", async () => {
    const output = await handleDreamCommand(
      ["status"],
      { agentId: AGENT_ID },
      {
        ...deps({
          readSettings: () => settings({ enabled: true }),
          readPressure: () => 1_500,
          readRuns: async () => [runRow()],
          readUsage: async () =>
            new Map([["run-1", { turns: 2, cost: 0.01234 }]]),
        }),
      },
    );
    expect(output).toContain("Dream: on");
    expect(output).toContain("Permission: acceptEdits");
    expect(output).toContain("Idle windows: 22:00–07:00 · silence 30m");
    expect(output).toContain("Pressure: 1,500 / 75,000 (2%)");
    expect(output).toContain("Budget: 100,000 tokens/run · no daily cap");
    expect(output).toContain(
      "Next run: unavailable (scheduler state not exposed yet)",
    );
    expect(output).toContain(
      "Last run: succeeded · 2h ago · 41,200 / 100,000 tokens · $ 0.01234",
    );
    expect(output).toContain("report: maintenance/2026-10-30.md");
  });

  test("a missing ledger row paints — instead of a zero cost", async () => {
    const output = await handleDreamCommand(
      ["status"],
      { agentId: AGENT_ID },
      {
        ...deps({ readRuns: async () => [runRow()] }),
      },
    );
    expect(output).toContain("tokens · —");
    expect(output).not.toContain("$ 0.00000");
  });

  test("zero pressure says the meter is not wired yet", async () => {
    const output = await handleDreamCommand([], { agentId: AGENT_ID }, deps());
    expect(output).toContain("Pressure: 0 / 75,000 (0%)");
    expect(output).toContain("meter not wired yet (M2)");
  });

  test("an unconfigured agent is told to finish setup", async () => {
    const output = await handleDreamCommand(
      [],
      { agentId: AGENT_ID },
      {
        ...deps({ isConfigured: () => false }),
      },
    );
    expect(output).toContain("Dream: off");
    expect(output).toContain("run /dream on to finish setup");
    expect(output).toContain("Last run: none");
  });

  test("recent runs count the failures, and budget exhaustion is not one", async () => {
    const output = await handleDreamCommand(
      ["status"],
      { agentId: AGENT_ID },
      {
        ...deps({
          readRuns: async () => [
            runRow({ runId: "a", status: "failed" }),
            runRow({ runId: "b", status: "budget_exhausted" }),
            runRow({ runId: "c", status: "timeout" }),
            runRow({ runId: "d", status: "cancelled" }),
          ],
        }),
      },
    );
    expect(output).toContain("Recent runs: 3 · 2 failed");
  });
});

describe("the on/off switch", () => {
  test("off writes one key and reports it", async () => {
    const writes: unknown[] = [];
    const output = await handleDreamCommand(
      ["off"],
      { agentId: AGENT_ID },
      {
        ...deps({ writeSettings: (patch) => writes.push(patch) }),
      },
    );
    expect(writes).toEqual([{ enabled: false }]);
    expect(output).toBe("Dream disabled.");
  });

  test("on without the submit path enables and names the missing setup", async () => {
    const writes: unknown[] = [];
    const output = await handleDreamCommand(
      ["on"],
      { agentId: AGENT_ID },
      {
        ...deps({
          isConfigured: () => false,
          writeSettings: (patch) => writes.push(patch),
          readSettings: () => settings({ enabled: true }),
        }),
      },
    );
    expect(writes).toEqual([{ enabled: true }]);
    expect(output).toContain("Setup is incomplete");
    expect(output).toContain("/dream on");
  });

  test("an explicit enable creates the carrier task once", async () => {
    const writes: unknown[] = [];
    const ensured: string[] = [];
    const output = await handleDreamCommand(
      ["on"],
      { agentId: AGENT_ID },
      {
        ...deps({
          isConfigured: () => true,
          writeSettings: (patch) => writes.push(patch),
          readSettings: () => settings({ enabled: true }),
          ensureTask: (id) => {
            ensured.push(id);
            return {};
          },
        }),
      },
    );
    expect(writes).toEqual([{ enabled: true }]);
    expect(ensured).toEqual([AGENT_ID]);
    expect(output).toContain("Dream enabled.");
    expect(output).not.toContain("could not be created");
  });

  test("a carrier-task failure is reported, and the switch still stands", async () => {
    const writes: unknown[] = [];
    const output = await handleDreamCommand(
      ["on"],
      { agentId: AGENT_ID },
      {
        ...deps({
          isConfigured: () => true,
          writeSettings: (patch) => writes.push(patch),
          ensureTask: () => {
            throw new Error("schedule store is read-only");
          },
        }),
      },
    );
    expect(writes).toEqual([{ enabled: true }]);
    expect(output).toContain(
      "Dream enabled, but the dream task could not be created: schedule store is read-only",
    );
    expect(output).toContain("run /dream on again to retry");
  });

  test("a per-agent override that keeps dream off is named, not claimed as enabled", async () => {
    const writes: unknown[] = [];
    const output = await handleDreamCommand(
      ["on"],
      { agentId: AGENT_ID },
      {
        ...deps({
          isConfigured: () => true,
          writeSettings: (patch) => writes.push(patch),
          readSettings: () => settings({ enabled: false }),
          ensureTask: () => ({ id: "task-1", status: "active" }),
        }),
      },
    );
    expect(writes).toEqual([{ enabled: true }]);
    expect(output).toContain("per-agent override");
    expect(output).not.toContain("will trigger");
  });

  test("auto-trigger off is named instead of promising idle runs", async () => {
    const output = await handleDreamCommand(
      ["on"],
      { agentId: AGENT_ID },
      {
        ...deps({
          isConfigured: () => true,
          readSettings: () => settings({ enabled: true, autoTrigger: false }),
          ensureTask: () => ({ id: "task-1", status: "active" }),
        }),
      },
    );
    expect(output).toContain("automatic triggering is off");
    expect(output).toContain("/dream run");
    expect(output).not.toContain("Runs will trigger");
  });

  test("a paused carrier task names its status and the resume command", async () => {
    const output = await handleDreamCommand(
      ["on"],
      { agentId: AGENT_ID },
      {
        ...deps({
          isConfigured: () => true,
          readSettings: () => settings({ enabled: true }),
          ensureTask: () => ({ id: "task-9", status: "paused" }),
        }),
      },
    );
    expect(output).toContain("schedule task is paused");
    expect(output).toContain("/schedule resume task-9");
    expect(output).not.toContain("Runs will trigger");
  });

  test("the first TUI enable raises the wizard instead of writing the switch", async () => {
    const runner = fakeRunner();
    const writes: unknown[] = [];
    let wizardOpened = 0;
    const result = await handleDreamSlashCommand("/dream on", {
      agentId: AGENT_ID,
      commandRunner: runner,
      isConfigured: () => false,
      openWizard: () => {
        wizardOpened += 1;
        return true;
      },
      writeSettings: (patch) => writes.push(patch),
    });
    expect(result.submitted).toBe(true);
    expect(wizardOpened).toBe(1);
    expect(writes).toEqual([]);
    // The overlay owns the command row; a second row would double-print.
    expect(runner.started).toEqual([]);
  });

  test("a configured agent's second /dream on does not raise the wizard", async () => {
    const runner = fakeRunner();
    let wizardOpened = 0;
    await handleDreamSlashCommand("/dream on", {
      agentId: AGENT_ID,
      commandRunner: runner,
      isConfigured: () => true,
      writeSettings: () => {},
      readSettings: () => settings({ enabled: true }),
      ensureTask: () => ({}),
      openWizard: () => {
        wizardOpened += 1;
        return true;
      },
    });
    expect(wizardOpened).toBe(0);
    expect(runner.finished.at(-1)?.output).toContain("Dream enabled");
  });

  test("when the wizard cannot be raised the switch is written and the setup named", async () => {
    const runner = fakeRunner();
    const writes: unknown[] = [];
    await handleDreamSlashCommand("/dream on", {
      agentId: AGENT_ID,
      commandRunner: runner,
      isConfigured: () => false,
      openWizard: () => false,
      writeSettings: (patch) => writes.push(patch),
      readSettings: () => settings({ enabled: true }),
      ensureTask: () => ({}),
    });
    expect(writes).toEqual([{ enabled: true }]);
    expect(runner.finished.at(-1)?.output).toContain("Setup is incomplete");
  });
});

describe("the run entrance (R-5.9.4)", () => {
  test("refuses before configuration with the setup instruction", async () => {
    const runner = fakeRunner();
    let launched = 0;
    await handleDreamSlashCommand("/dream run", {
      agentId: AGENT_ID,
      commandRunner: runner,
      isConfigured: () => false,
      startRun: async () => {
        launched += 1;
        return { started: true, runId: "run-1" };
      },
    });
    expect(launched).toBe(0);
    expect(runner.failed.at(-1)?.output).toContain("not configured yet");
    expect(runner.failed.at(-1)?.output).toContain("/dream on");
  });

  test("refuses while the master switch is off", async () => {
    const runner = fakeRunner();
    await handleDreamSlashCommand("/dream run", {
      agentId: AGENT_ID,
      commandRunner: runner,
      isConfigured: () => true,
      readSettings: () => settings({ enabled: false }),
    });
    expect(runner.failed.at(-1)?.output).toBe(
      "Dream is off. Run /dream on first.",
    );
  });

  test("delegates through the launcher seam and passes --budget", async () => {
    const runner = fakeRunner();
    const launches: Array<{ agentId: string; budgetOverrideTokens?: number }> =
      [];
    await handleDreamSlashCommand("/dream run --budget 50000", {
      agentId: AGENT_ID,
      commandRunner: runner,
      isConfigured: () => true,
      readSettings: () => settings({ enabled: true }),
      startRun: async (input) => {
        launches.push(input);
        return { started: true, runId: "run-7" };
      },
    });
    expect(launches).toEqual([
      { agentId: AGENT_ID, budgetOverrideTokens: 50_000 },
    ]);
    expect(runner.finished.at(-1)?.output).toContain("run-7");
    expect(runner.finished.at(-1)?.output).toContain("50,000-token budget");
  });

  test("shows the launcher's refusal reason to the user", async () => {
    const runner = fakeRunner();
    await handleDreamSlashCommand("/dream run", {
      agentId: AGENT_ID,
      commandRunner: runner,
      isConfigured: () => true,
      readSettings: () => settings({ enabled: true }),
      startRun: async () => ({
        started: false,
        runId: null,
        reason: "another dream run is active",
      }),
    });
    expect(runner.failed.at(-1)?.output).toBe(
      "Dream run did not start: another dream run is active.",
    );
  });

  test("an invalid budget reports the usage line and never launches", async () => {
    const runner = fakeRunner();
    let launched = 0;
    await handleDreamSlashCommand("/dream run --budget zero", {
      agentId: AGENT_ID,
      commandRunner: runner,
      startRun: async () => {
        launched += 1;
        return { started: true, runId: "run-1" };
      },
    });
    expect(launched).toBe(0);
    expect(runner.failed.at(-1)?.output).toContain("Usage: /dream");
  });
});

describe("the config entrance", () => {
  test("raises the Settings page and names the section", async () => {
    const runner = fakeRunner();
    await handleDreamSlashCommand("/dream config", {
      agentId: AGENT_ID,
      commandRunner: runner,
      openSettings: () => true,
    });
    expect(runner.finished.at(-1)?.output).toContain("Settings → Dream");
  });

  test("the append shell is told the page needs the full-screen shell", async () => {
    const runner = fakeRunner();
    await handleDreamSlashCommand("/dream config", {
      agentId: AGENT_ID,
      commandRunner: runner,
      openSettings: () => false,
    });
    expect(runner.failed.at(-1)?.output).toContain("full-screen TUI");
  });
});

describe("the shared status vocabulary", () => {
  test("budget exhaustion and cancellation are not failures", () => {
    expect(isDreamRunFailure("failed")).toBe(true);
    expect(isDreamRunFailure("timeout")).toBe(true);
    expect(isDreamRunFailure("unfinished")).toBe(true);
    expect(isDreamRunFailure("succeeded")).toBe(false);
    expect(isDreamRunFailure("budget_exhausted")).toBe(false);
    expect(isDreamRunFailure("cancelled")).toBe(false);
    expect(isDreamRunFailure("running")).toBe(false);
  });

  test("status labels are the requirement's words", () => {
    expect(dreamRunStatusLabel("budget_exhausted")).toBe("budget exhausted");
    expect(dreamRunStatusLabel("unfinished")).toBe("unfinished");
  });

  test("relative run time is bounded at the day", () => {
    const now = Date.parse("2026-10-30T20:00:00.000Z");
    expect(formatDreamRunTime(now - 30_000, now)).toBe("just now");
    expect(formatDreamRunTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatDreamRunTime(now - 5 * 3_600_000, now)).toBe("5h ago");
    expect(formatDreamRunTime(now - 3 * 86_400_000, now)).toBe("3d ago");
    expect(formatDreamRunTime(null, now)).toBe("time unknown");
  });
});

describe("isDreamConfigured", () => {
  test("an uninitialized settings manager is not configured", () => {
    // The singleton is not initialized in this test file; the reader must
    // degrade to false rather than throw.
    expect(isDreamConfigured(AGENT_ID)).toBe(false);
  });
});

describe("the note entrances (F-06 §2.3)", () => {
  function note(overrides: Partial<DreamNote> = {}): DreamNote {
    return {
      version: 1,
      id: "note-1234abcd",
      createdAt: Date.parse("2026-10-30T18:00:00.000Z"),
      author: "user",
      text: "tidy the projects folder",
      source: {},
      ...overrides,
    };
  }

  test("note add appends author=user with the conversation as source", async () => {
    const appended: unknown[] = [];
    const output = await handleDreamCommand(
      ["note", "tidy", "the", "projects"],
      { agentId: AGENT_ID, conversationId: "conv-9" },
      deps({
        appendNote: async (agentId, input) => {
          appended.push({ agentId, input });
          return {
            ok: true,
            note: note({ id: "note-1234abcd", text: input.text }),
          };
        },
      }),
    );
    expect(appended).toEqual([
      {
        agentId: AGENT_ID,
        input: {
          text: "tidy the projects",
          author: "user",
          source: { conversationId: "conv-9" },
        },
      },
    ]);
    expect(output).toContain("note-1234abcd");
    expect(output).toContain("next dream run");
  });

  test("a refused append shows the queue's own reason", async () => {
    const output = await handleDreamCommand(
      ["note", "one too many"],
      { agentId: AGENT_ID },
      deps({
        appendNote: async () => ({
          ok: false,
          error:
            "The dream note queue is full (50 notes), so nothing was added.",
        }),
      }),
    );
    expect(output).toContain("queue is full");
  });

  test("notes lists id, author, age and a summary", async () => {
    const output = await handleDreamCommand(
      ["notes"],
      { agentId: AGENT_ID },
      deps({
        readNotes: async () => [
          note(),
          note({
            id: "note-9999abcd",
            author: "dream",
            createdAt: Date.parse("2026-10-30T19:00:00.000Z"),
            text: `long note ${"x".repeat(200)}`,
          }),
        ],
      }),
    );
    expect(output).toContain("Dream notes: 2 pending (max 50)");
    expect(output).toContain(
      "note-1234abcd · user · 2h ago · tidy the projects folder",
    );
    expect(output).toContain("note-9999abcd · dream · 1h ago · long note");
    expect(output).toContain("…");
  });

  test("an empty queue says so and names the way to add one", async () => {
    const output = await handleDreamCommand(
      ["notes"],
      { agentId: AGENT_ID },
      deps({ readNotes: async () => [] }),
    );
    expect(output).toBe(
      "No pending dream notes. Add one with /dream note <text>.",
    );
  });

  test("note remove reports whether the id existed", async () => {
    const seen: string[] = [];
    const removed = await handleDreamCommand(
      ["note", "remove", "note-1234abcd"],
      { agentId: AGENT_ID },
      deps({
        removeNote: async (_agentId, id) => {
          seen.push(id);
          return true;
        },
      }),
    );
    expect(seen).toEqual(["note-1234abcd"]);
    expect(removed).toBe("Removed dream note note-1234abcd.");

    const missing = await handleDreamCommand(
      ["note", "remove", "note-ffffffff"],
      { agentId: AGENT_ID },
      deps({ removeNote: async () => false }),
    );
    expect(missing).toContain("No dream note matches");
    expect(missing).toContain("/dream notes");
  });

  test("notes clear reports the count it removed", async () => {
    const three = await handleDreamCommand(
      ["notes", "clear"],
      { agentId: AGENT_ID },
      deps({ clearNotes: async () => 3 }),
    );
    expect(three).toBe("Cleared 3 dream notes.");
    const one = await handleDreamCommand(
      ["notes", "clear"],
      { agentId: AGENT_ID },
      deps({ clearNotes: async () => 1 }),
    );
    expect(one).toBe("Cleared 1 dream note.");
    const none = await handleDreamCommand(
      ["notes", "clear"],
      { agentId: AGENT_ID },
      deps({ clearNotes: async () => 0 }),
    );
    expect(none).toBe("There were no dream notes to clear.");
  });

  test("the TUI submit path runs the same note actions", async () => {
    const runner = fakeRunner();
    await handleDreamSlashCommand("/dream note remember the archive", {
      agentId: AGENT_ID,
      commandRunner: runner,
      appendNote: async (_agentId, input) => ({
        ok: true,
        note: note({ id: "note-aaaa1111", text: input.text }),
      }),
    });
    expect(runner.started.at(-1)?.output).toBe("Saving a dream note...");
    expect(runner.finished.at(-1)?.output).toContain("note-aaaa1111");
  });
});

describe("the idle-window editor", () => {
  test("round-trips several windows, including a cross-midnight one", () => {
    const windows = [
      { start: "22:00", end: "07:00" },
      { start: "12:30", end: "13:30" },
    ];
    const text = formatDreamWindowsInput(windows);
    expect(text).toBe("22:00-07:00, 12:30-13:30");
    expect(parseDreamWindowsInput(text)).toEqual(windows);
  });

  test("refuses malformed, empty or zero-length windows instead of defaulting", () => {
    for (const bad of [
      "",
      "22:00",
      "22:00-25:00",
      "22:00-22:00",
      "9:00-10:00",
      "22:00-07:00, nope",
    ]) {
      expect({ bad, parsed: parseDreamWindowsInput(bad) }).toEqual({
        bad,
        parsed: null,
      });
    }
  });
});
