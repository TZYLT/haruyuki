/**
 * `/recall` — feature ②'s single configuration entry point (《26》§6.8).
 *
 * One command instead of ten, because every knob is a preference with a
 * documented default rather than a mode the user has to remember to leave. With
 * no arguments the TUI opens a picker (see `RecallOverlay`); every other channel
 * gets the parameter table and the usage, which is what `/topic` does and is the
 * only useful answer to "what is recall set to?" in a non-interactive surface.
 *
 * The parser is pure and separate from the effects so the accepted spellings,
 * the rejections, and the copy can be tested without a store or a backend.
 */
import type { DreamCommandScope } from "@/agent/reflection-runs";
import { type Backend, getBackend } from "@/backend";
import { LocalBackend } from "@/backend/local/local-backend";
import { buildRecallCorpus } from "@/backend/local/recall-build";
import {
  type ResolvedRecallSettings,
  readRecallSettings,
} from "@/recall-settings";
import {
  isRecallDisplay,
  type RecallDisplay,
} from "@/reminders/recall-display";
import type { RecallDiversity } from "@/reminders/recall-port";
import { formatRecallProbeLines } from "@/reminders/recall-probe";
import { resetRecallRuntime } from "@/reminders/recall-runtime";
import { runRecall } from "@/reminders/recall-service";
import {
  collectRecallStatus,
  formatRecallStatus,
} from "@/reminders/recall-status";
import { type Settings, settingsManager } from "@/settings-manager";

export const RECALL_COMMAND_USAGE = [
  "/recall [setting] [value]",
  "",
  "Passive recall: earlier conversations and memory files the agent has not",
  "been shown are searched before each turn, and what matches is injected with",
  "the user message.",
  "",
  "USAGE",
  "  /recall                       open the settings picker",
  "  /recall status                what recall is doing right now",
  "  /recall on | off              switch passive recall on or off",
  "  /recall build                 build the transcript index it needs",
  "  /recall now <query>           run a search and show the passages",
  "  /recall timeout <ms>          wall-clock budget (0 = no limit)",
  "  /recall dedup <turns>         how long a passage stays suppressed",
  "  /recall limit <n>             passages injected per turn",
  "  /recall excerpt <±lines>      memory context around a hit",
  "  /recall chars <per> [total]   per-passage and total character budget",
  "  /recall ratio <0..1>          relative score floor",
  "  /recall diversity <mode>      none | file | split",
  "  /recall display <tier>        silent | summary | full",
].join("\n");

export type RecallCommand =
  | { kind: "usage" }
  | { kind: "error"; message: string }
  | { kind: "status" }
  | { kind: "build" }
  | { kind: "probe"; query: string }
  /** Value changes; `label` names the knob in the receipt. */
  | { kind: "set"; label: string; updates: Partial<Settings> }
  /** `/recall on` also clears the breaker (《26》§6.6: manual recovery only). */
  | { kind: "enable" }
  | { kind: "disable" };

const DIVERSITIES: readonly RecallDiversity[] = ["none", "file", "split"];

/**
 * A non-negative whole number, or `null` when the text is not one.
 *
 * `0` is always accepted: for every knob here it means "off" (no budget, no
 * window, no entries) rather than "unset".
 */
export function parseRecallCount(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const text = raw.trim();
  if (text === "" || !/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * A ratio in `[0, 1]`.
 *
 * Above 1 is refused rather than clamped: `minScoreRatio` above 1 means "no score
 * can ever clear the floor", so a typo would silently disable recall, and a
 * refusal says so.
 */
export function parseRecallRatio(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const text = raw.trim();
  if (text === "") return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0 || value > 1) return null;
  return value;
}

function error(message: string): RecallCommand {
  return { kind: "error", message };
}

export function parseRecallCommand(args: string[]): RecallCommand {
  const [head, ...rest] = args;
  if (head === undefined || head === "help") return { kind: "usage" };

  switch (head) {
    case "on":
      return rest.length === 0
        ? { kind: "enable" }
        : error("`/recall on` takes no arguments.");
    case "off":
      return rest.length === 0
        ? { kind: "disable" }
        : error("`/recall off` takes no arguments.");
    case "status":
      return rest.length === 0
        ? { kind: "status" }
        : error("`/recall status` takes no arguments.");
    case "build":
      return rest.length === 0
        ? { kind: "build" }
        : error("`/recall build` takes no arguments.");
    case "now": {
      const query = rest.join(" ").trim();
      return query.length === 0
        ? error("`/recall now` needs a query: /recall now <text>.")
        : { kind: "probe", query };
    }
    case "timeout": {
      const value = parseRecallCount(rest[0]);
      return value === null
        ? error(
            "`/recall timeout` needs milliseconds: /recall timeout 1000 (0 = no limit).",
          )
        : {
            kind: "set",
            label: "timeout",
            updates: { recallTimeoutMs: value },
          };
    }
    case "dedup": {
      const value = parseRecallCount(rest[0]);
      return value === null
        ? error(
            "`/recall dedup` needs a number of turns: /recall dedup 10 (0 = no window).",
          )
        : {
            kind: "set",
            label: "dedup window",
            updates: { recallDedupTurns: value },
          };
    }
    case "limit": {
      const value = parseRecallCount(rest[0]);
      return value === null
        ? error(
            "`/recall limit` needs a number of passages: /recall limit 3 (0 = none).",
          )
        : { kind: "set", label: "limit", updates: { recallLimit: value } };
    }
    case "excerpt": {
      const value = parseRecallCount(rest[0]);
      return value === null
        ? error(
            "`/recall excerpt` needs a line count: /recall excerpt 2 (0 = the hit line only).",
          )
        : {
            kind: "set",
            label: "excerpt lines",
            updates: { recallExcerptLines: value },
          };
    }
    case "ratio": {
      const value = parseRecallRatio(rest[0]);
      return value === null
        ? error(
            "`/recall ratio` needs a number from 0 to 1: /recall ratio 0.35.",
          )
        : {
            kind: "set",
            label: "score ratio",
            updates: { recallMinScoreRatio: value },
          };
    }
    case "diversity": {
      const value = rest[0];
      return DIVERSITIES.includes(value as RecallDiversity)
        ? {
            kind: "set",
            label: "diversity",
            updates: { recallDiversity: value as RecallDiversity },
          }
        : error("`/recall diversity` needs one of: none, file, split.");
    }
    case "display": {
      const value = rest[0];
      return isRecallDisplay(value)
        ? {
            kind: "set",
            label: "display",
            updates: { recallDisplay: value as RecallDisplay },
          }
        : error("`/recall display` needs one of: silent, summary, full.");
    }
    case "chars": {
      const perEntry = parseRecallCount(rest[0]);
      if (perEntry === null) {
        return error(
          "`/recall chars` needs a per-passage budget: /recall chars 400 [total].",
        );
      }
      if (rest.length > 2) {
        return error("`/recall chars` takes at most two numbers.");
      }
      if (rest.length === 1) {
        return {
          kind: "set",
          label: "excerpt characters",
          updates: { recallExcerptCharacters: perEntry },
        };
      }
      const total = parseRecallCount(rest[1]);
      if (total === null) {
        return error(
          "`/recall chars` needs a total budget as its second number.",
        );
      }
      return {
        kind: "set",
        label: "character budget",
        updates: {
          recallExcerptCharacters: perEntry,
          recallTotalCharacters: total,
        },
      };
    }
    default:
      return error(`Unknown recall setting: ${head}`);
  }
}

/** One line naming every effective knob; used by the receipt and by `status`. */
export function formatRecallSettingsLine(
  settings: ResolvedRecallSettings,
): string {
  return `limit ${settings.limit} · excerpt ${settings.excerptCharacters}/${settings.totalCharacters} chars · ratio ${settings.minScoreRatio} · diversity ${settings.diversity} · dedup ${settings.dedupTurns} turns · timeout ${
    settings.timeoutMs === 0 ? "none" : `${settings.timeoutMs}ms`
  } · display ${settings.display}`;
}

const RECALL_LOCAL_ONLY =
  "Passive recall is local-backend only: it searches this machine's transcripts and memory files.";

export interface RecallCommandDeps {
  backend?: Backend;
}

function requireSettings(): string | null {
  try {
    settingsManager.getSettings();
    return null;
  } catch {
    return "Settings are not loaded yet.";
  }
}

/**
 * Run one `/recall` invocation.
 *
 * The picker is not here: the TUI intercepts a bare `/recall` before the registry
 * so the overlay can own the keyboard (`RecallOverlay`). Every other spelling
 * lands here, in every channel.
 */
export async function handleRecallCommand(
  args: string[],
  scope?: DreamCommandScope,
  deps: RecallCommandDeps = {},
): Promise<string> {
  const command = parseRecallCommand(args);

  if (command.kind === "usage") return RECALL_COMMAND_USAGE;
  if (command.kind === "error") {
    return `${command.message}\n\n${RECALL_COMMAND_USAGE}`;
  }

  if (
    command.kind === "set" ||
    command.kind === "enable" ||
    command.kind === "disable"
  ) {
    const unloaded = requireSettings();
    if (unloaded) return unloaded;
    if (command.kind === "enable") {
      settingsManager.updateSettings({ recallEnabled: true });
      // The trip is in-memory, and only `/recall on` clears it (《26》§6.6).
      resetRecallRuntime();
    } else if (command.kind === "disable") {
      settingsManager.updateSettings({ recallEnabled: false });
    } else {
      settingsManager.updateSettings(command.updates);
    }
    const updated = readRecallSettings();
    const what =
      command.kind === "set"
        ? `Updated ${command.label}.`
        : command.kind === "enable"
          ? "Passive recall is on."
          : "Passive recall is off: nothing is searched.";
    return `${what}\n  ${formatRecallSettingsLine(updated)}`;
  }

  // Everything below needs the local store. A cloud backend manages context
  // server-side and has neither transcripts nor a memory workspace to search.
  const backend = deps.backend ?? getBackend();
  if (!(backend instanceof LocalBackend)) return RECALL_LOCAL_ONLY;
  const storageDir = backend.getLocalStorageDir();

  if (command.kind === "status") {
    return formatRecallStatus(
      collectRecallStatus({
        storageDir,
        ...(scope?.agentId === undefined ? {} : { agentId: scope.agentId }),
      }),
    ).join("\n");
  }

  if (command.kind === "build") {
    const result = await buildRecallCorpus(storageDir, { yieldEvery: 8 });
    const lines = [
      `Indexed ${result.indexed}/${result.conversations} conversation${result.conversations === 1 ? "" : "s"} · ${result.records} record${result.records === 1 ? "" : "s"} · ${result.elapsedMs}ms`,
    ];
    if (result.skipped > 0) {
      lines.push(
        `  ${result.skipped} conversation${result.skipped === 1 ? "" : "s"} had no transcript.`,
      );
    }
    for (const failure of result.failures) {
      lines.push(`  ${failure.conversationKey}: ${failure.reason}`);
    }
    if (result.indexed === 0 && result.failures.length === 0) {
      lines.push("  There was nothing to index yet.");
    }
    return lines.join("\n");
  }

  // `probe`: the manual trial run. It answers "what can recall find for this
  // query", so nothing is suppressed and nothing is recorded — see `runRecall`'s
  // `dryRun`.
  if (!scope?.agentId) return "A recall probe needs an active agent.";
  const probeSettings = readRecallSettings();
  const decision = await runRecall({
    backend,
    agentId: scope.agentId,
    conversationId: scope.conversationId ?? "default",
    userText: command.query,
    // Unused under `dryRun`: neither the window read nor the write happens.
    currentTurn: 0,
    dryRun: true,
    options: {
      limit: probeSettings.limit,
      excerptCharacters: probeSettings.excerptCharacters,
      totalCharacters: probeSettings.totalCharacters,
      minScoreRatio: probeSettings.minScoreRatio,
      diversity: probeSettings.diversity,
      excerptLines: probeSettings.excerptLines,
      timeoutMs: probeSettings.timeoutMs,
      // The window is what the probe exists to look past.
      dedupTurns: 0,
    },
  });
  return formatRecallProbeLines(decision).join("\n");
}
