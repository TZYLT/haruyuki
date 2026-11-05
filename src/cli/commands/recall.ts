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
  type EmbeddingCommandDeps,
  handleEmbeddingCommand,
} from "@/cli/commands/embedding";
import { setRecallDisplay } from "@/cli/components/transcript-display-state";
import { createEmbeddingRuntimePort } from "@/cli/helpers/embedding-runtime";
import {
  formatRecallSettingsLine,
  type ResolvedEmbeddingSettings,
  type ResolvedRecallSettings,
  readEmbeddingSettings,
  readRecallSettings,
  recallOptionsFromSettings,
} from "@/recall-settings";
import { isRecallDisplay } from "@/reminders/recall-display";
import { maybeCreateRecallEmbeddingArms } from "@/reminders/recall-embedding-arms";
import { isRecallDiversity } from "@/reminders/recall-port";
import { formatRecallProbeLines } from "@/reminders/recall-probe";
import { resetRecallRuntime } from "@/reminders/recall-runtime";
import { runRecall } from "@/reminders/recall-service";
import {
  collectRecallStatus,
  formatRecallStatus,
} from "@/reminders/recall-status";
import { type Settings, settingsManager } from "@/settings-manager";

export const RECALL_COMMAND_USAGE = [
  "/recall [command]",
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
  "  /recall config                list every tuning key and its value",
  "  /recall config <key>          show one key",
  "  /recall config <key> <value>  set one key",
  "  /recall embedding <command>   vector recall (status, on, off, connect, model, build, config, device)",
  "",
  "KEYS",
  "  timeout <ms>                  wall-clock budget (0 = no limit)",
  "  dedup <turns>                 how long a passage stays suppressed",
  "  limit <n>                     passages injected per turn",
  "  excerpt <±lines>              memory context around a hit",
  "  chars <per> [total]           per-passage and total character budget",
  "  ratio <0..1>                  relative score floor (lexical and fused)",
  "  diversity <mode>              none | file | split",
  "  display <tier>                silent | summary | full",
  "  weight <0..1>                 vector-arm weight (needs vector recall on)",
  "  depth <n>                     candidates per arm (needs vector recall on)",
].join("\n");

export type RecallCommand =
  | { kind: "usage" }
  | { kind: "error"; message: string }
  | { kind: "status" }
  | { kind: "build" }
  | { kind: "probe"; query: string }
  /** `/recall config` with no key, or one key to print. */
  | { kind: "config"; key?: RecallConfigKey }
  /**
   * `/recall embedding …` (feature ③): parsed here so the two command groups
   * share one dispatcher, then handed to `cli/commands/embedding.ts` whole. The
   * sub-parser owns every spelling after `embedding`.
   */
  | { kind: "embedding"; args: string[] }
  /** Value changes; `label` names the knob in the receipt. */
  | { kind: "set"; label: string; updates: Partial<Settings> }
  /** `/recall on` also clears the breaker (《26》§6.6: manual recovery only). */
  | { kind: "enable" }
  | { kind: "disable" };

/** Every key `/recall config` accepts (48-4 D-05/D-16). */
export type RecallConfigKey =
  | "timeout"
  | "dedup"
  | "limit"
  | "excerpt"
  | "chars"
  | "ratio"
  | "diversity"
  | "display"
  | "weight"
  | "depth";

const RECALL_CONFIG_KEYS: readonly RecallConfigKey[] = [
  "timeout",
  "dedup",
  "limit",
  "excerpt",
  "chars",
  "ratio",
  "diversity",
  "display",
  "weight",
  "depth",
];

function isRecallConfigKey(
  value: string | undefined,
): value is RecallConfigKey {
  return (
    value !== undefined &&
    (RECALL_CONFIG_KEYS as readonly string[]).includes(value)
  );
}

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

/**
 * The value of a one-value knob, or `undefined` when it is missing or has company.
 *
 * A trailing word is refused rather than ignored, which is what `on`, `off`,
 * `status`, `build` and `chars` already do: `/recall timeout 500 junk` looking
 * like it worked leaves the user believing they set a knob they did not.
 */
function oneValue(rest: string[]): string | undefined {
  return rest.length === 1 ? rest[0] : undefined;
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
    case "config":
      return parseRecallConfig(rest);
    case "embedding":
      // No validation here: `parseEmbeddingCommand` owns that vocabulary and
      // reports its own errors, so this dispatcher only splits the command.
      return { kind: "embedding", args: rest };
    default:
      return error(`Unknown recall command: ${head}. Try /recall config.`);
  }
}

/** `/recall config …`: no key lists everything, one key prints it. */
function parseRecallConfig(args: string[]): RecallCommand {
  const [key, ...rest] = args;
  if (key === undefined) return { kind: "config" };
  if (!isRecallConfigKey(key)) {
    return error(
      `Unknown recall config key: ${key}. Keys: ${RECALL_CONFIG_KEYS.join(", ")}.`,
    );
  }
  if (rest.length === 0) return { kind: "config", key };
  return parseRecallKnob(key, rest);
}

/** One key's value; the accepted shape is per key, not "anything goes". */
function parseRecallKnob(key: RecallConfigKey, rest: string[]): RecallCommand {
  switch (key) {
    case "timeout": {
      const value = parseRecallCount(oneValue(rest));
      return value === null
        ? error(
            "`/recall config timeout` needs milliseconds: /recall config timeout 1000 (0 = no limit).",
          )
        : {
            kind: "set",
            label: "timeout",
            updates: { recallTimeoutMs: value },
          };
    }
    case "dedup": {
      const value = parseRecallCount(oneValue(rest));
      return value === null
        ? error(
            "`/recall config dedup` needs a number of turns: /recall config dedup 10 (0 = no window).",
          )
        : {
            kind: "set",
            label: "dedup window",
            updates: { recallDedupTurns: value },
          };
    }
    case "limit": {
      const value = parseRecallCount(oneValue(rest));
      return value === null
        ? error(
            "`/recall config limit` needs a number of passages: /recall config limit 3 (0 = none).",
          )
        : { kind: "set", label: "limit", updates: { recallLimit: value } };
    }
    case "excerpt": {
      const value = parseRecallCount(oneValue(rest));
      return value === null
        ? error(
            "`/recall config excerpt` needs a line count: /recall config excerpt 2 (0 = the hit line only).",
          )
        : {
            kind: "set",
            label: "excerpt lines",
            updates: { recallExcerptLines: value },
          };
    }
    case "ratio": {
      const value = parseRecallRatio(oneValue(rest));
      return value === null
        ? error(
            "`/recall config ratio` needs a number from 0 to 1: /recall config ratio 0.35.",
          )
        : {
            kind: "set",
            label: "score ratio",
            updates: { recallMinScoreRatio: value },
          };
    }
    case "diversity": {
      const value = oneValue(rest);
      return isRecallDiversity(value)
        ? {
            kind: "set",
            label: "diversity",
            updates: { recallDiversity: value },
          }
        : error("`/recall config diversity` needs one of: none, file, split.");
    }
    case "display": {
      const value = oneValue(rest);
      return isRecallDisplay(value)
        ? {
            kind: "set",
            label: "display",
            updates: { recallDisplay: value },
          }
        : error(
            "`/recall config display` needs one of: silent, summary, full.",
          );
    }
    case "weight": {
      const value = parseRecallRatio(oneValue(rest));
      return value === null
        ? error(
            "`/recall config weight` needs a number from 0 to 1: /recall config weight 0.5.",
          )
        : {
            kind: "set",
            label: "vector weight",
            updates: { recallEmbeddingWeight: value },
          };
    }
    case "depth": {
      const value = parseRecallCount(oneValue(rest));
      return value === null
        ? error(
            "`/recall config depth` needs a candidate count: /recall config depth 50.",
          )
        : {
            kind: "set",
            label: "candidate depth",
            updates: { recallEmbeddingCandidateDepth: value },
          };
    }
    case "chars": {
      const perEntry = parseRecallCount(rest[0]);
      if (perEntry === null) {
        return error(
          "`/recall config chars` needs a per-passage budget: /recall config chars 400 [total].",
        );
      }
      if (rest.length > 2) {
        return error("`/recall config chars` takes at most two numbers.");
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
          "`/recall config chars` needs a total budget as its second number.",
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
  }
}

/**
 * `/recall config` output (48-4 D-05).
 *
 * One table instead of one command per knob: the values are what the user came
 * for, and `weight`/`depth` are marked as vector-only so a lexical-only setup
 * does not look broken.
 */
export function formatRecallConfigLines(
  recall: ResolvedRecallSettings,
  embedding: ResolvedEmbeddingSettings,
  key?: RecallConfigKey,
): string {
  const note = embedding.enabled ? "vector recall on" : "vector recall off";
  const rows: Record<RecallConfigKey, string> = {
    timeout:
      recall.timeoutMs === 0 ? "0 ms (no limit)" : `${recall.timeoutMs} ms`,
    dedup: `${recall.dedupTurns} turns`,
    limit: `${recall.limit}`,
    excerpt: `${recall.excerptLines} lines`,
    chars: `${recall.excerptCharacters} / ${recall.totalCharacters}`,
    ratio: `${recall.minScoreRatio}`,
    diversity: recall.diversity,
    display: recall.display,
    weight: `${embedding.weight} (${note})`,
    depth: `${embedding.candidateDepth} (${note})`,
  };
  if (key !== undefined) {
    return `${key}: ${rows[key]}\nSet it with /recall config ${key} <value>.`;
  }
  const width = Math.max(...RECALL_CONFIG_KEYS.map((name) => name.length));
  const lines = ["Recall config"];
  for (const name of RECALL_CONFIG_KEYS) {
    lines.push(`  ${name.padEnd(width)}  ${rows[name]}`);
  }
  lines.push("Set one with /recall config <key> <value>.");
  return lines.join("\n");
}

const RECALL_LOCAL_ONLY =
  "Passive recall is local-backend only: it searches this machine's transcripts and memory files.";

/** A probe has to search *somewhere*; the message is shared with the CLI subcommand. */
const RECALL_PROBE_NEEDS_AGENT = "A recall probe needs an active agent.";

export { RECALL_LOCAL_ONLY, RECALL_PROBE_NEEDS_AGENT };

export interface RecallCommandDeps {
  backend?: Backend;
  /**
   * Feature ③'s seams, passed through to `handleEmbeddingCommand`. The TUI and
   * the CLI subcommand both leave this empty; integration (and tests) inject a
   * runtime fake here rather than growing this module's surface.
   */
  embedding?: EmbeddingCommandDeps;
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
 * Write recall settings the way every surface must.
 *
 * Three things move together and a surface that writes only the first leaves the
 * other two behind: the settings record, the display store the transcript reads on
 * every render, and the in-memory breaker. The breaker matters because `/recall on`
 * is the only recovery from a trip (the trip is deliberately not persisted), so
 * "on" has to mean "clear the trip" wherever it is said — the picker is the same
 * promise as the command.
 */
export function applyRecallSettingsChange(
  updates: Partial<Settings>,
): ResolvedRecallSettings {
  settingsManager.updateSettings(updates);
  if (updates.recallEnabled === true) resetRecallRuntime();
  const updated = readRecallSettings();
  // The transcript reads its tier from the display store rather than from settings
  // on every render, so a change has to be pushed to it — the same thing
  // `/config system-reminders` does for its own toggle. A headless process never renders
  // it and the write is inert.
  setRecallDisplay(updated.display);
  return updated;
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

  // Feature ③ is settings- and runtime-scoped rather than store-scoped, so it
  // never waits on the local-backend check below: `/recall embedding off` must
  // work even when the agent's store is unreadable.
  if (command.kind === "embedding") {
    const embedding = deps.embedding ?? {};
    // The TUI hands its scope and returns an immediate receipt; the CLI
    // subcommand injects a backend, which is this dispatcher's only signal that
    // a build must be awaited to completion (48-1 §7.1: no prompt to block).
    const lifecycle =
      embedding.lifecycle ?? (deps.backend === undefined ? "tui" : "headless");
    return handleEmbeddingCommand(command.args, scope, {
      ...embedding,
      lifecycle,
      runtime:
        embedding.runtime === undefined
          ? createEmbeddingRuntimePort({
              ...(deps.backend === undefined ? {} : { backend: deps.backend }),
              lifecycle,
            })
          : embedding.runtime,
    });
  }

  if (command.kind === "config") {
    const unloaded = requireSettings();
    if (unloaded) return unloaded;
    return formatRecallConfigLines(
      readRecallSettings(),
      readEmbeddingSettings(),
      command.key,
    );
  }

  if (
    command.kind === "set" ||
    command.kind === "enable" ||
    command.kind === "disable"
  ) {
    const unloaded = requireSettings();
    if (unloaded) return unloaded;
    const updated = applyRecallSettingsChange(
      command.kind === "set"
        ? command.updates
        : // `/recall on` also clears the breaker; the helper is what makes that
          // true for every surface rather than just this one.
          { recallEnabled: command.kind === "enable" },
    );
    const what =
      command.kind === "set"
        ? `Updated ${command.label}.`
        : command.kind === "enable"
          ? "Passive recall is on."
          : "Passive recall is off: nothing is searched.";
    const lines = [what, `  ${formatRecallSettingsLine(updated)}`];
    // weight/depth live on the embedding settings record, so the recall summary
    // above cannot show them; print the vector side when one of them changed.
    if (
      command.kind === "set" &&
      ("recallEmbeddingWeight" in command.updates ||
        "recallEmbeddingCandidateDepth" in command.updates)
    ) {
      const embedding = readEmbeddingSettings();
      lines.push(
        `  Vector arm: weight ${embedding.weight} · depth ${embedding.candidateDepth} (${embedding.enabled ? "on" : "off"})`,
      );
    }
    return lines.join("\n");
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
  if (!scope?.agentId) return RECALL_PROBE_NEEDS_AGENT;
  const probeSettings = readRecallSettings();
  // Feature ③: the manual trial run shows what the real turn would see, so when
  // the vector arm is enabled it is fused exactly as the turn path does. The
  // factory returns null when there is no usable space, which keeps the probe
  // lexical-only instead of failing.
  const embeddingSettings = readEmbeddingSettings();
  const embeddingArms = embeddingSettings.enabled
    ? maybeCreateRecallEmbeddingArms({
        backend,
        agentId: scope.agentId,
        settings: embeddingSettings,
      })
    : null;
  const decision = await runRecall({
    backend,
    agentId: scope.agentId,
    conversationId: scope.conversationId ?? "default",
    userText: command.query,
    // Unused under `dryRun`: neither the window read nor the write happens.
    currentTurn: 0,
    dryRun: true,
    // One builder for a full option record, so a new tunable cannot be honoured by
    // the turn path and silently defaulted here.
    options: {
      ...recallOptionsFromSettings(probeSettings),
      // The window is what the probe exists to look past.
      dedupTurns: 0,
    },
    ...(embeddingArms === null
      ? {}
      : {
          vectorSource: embeddingArms.vectorSource,
          fusion: embeddingArms.fusion,
        }),
  });
  return formatRecallProbeLines(decision).join("\n");
}
