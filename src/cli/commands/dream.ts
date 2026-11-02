/**
 * `/dream` — the dream command group (F-06 M4, requirement R-5.9.2 / R-5.9.1).
 *
 * `/dream` is no longer an alias of `/reflect`: reflection keeps `/reflect`,
 * and this module owns the four entrances plus the status face:
 *
 * - `/dream` / `/dream status` — read-only: settings, run records, ledger spend;
 * - `/dream run [--budget <n>]` — delegate one run through the frozen launcher
 *   seam (`helpers/dream-launcher.ts`, S5); this module never spawns a process;
 * - `/dream config` — raise the Settings page's Dream section;
 * - `/dream on|off` — the master switch shortcut.
 *
 * Two properties are load-bearing.
 *
 * - **The registry handler and the TUI handler are one implementation.** The
 *   submit path (which can raise an overlay) and `executeCommand` (which cannot)
 *   both call `runDreamAction`; only the *effects* differ. That is what stops
 *   `/dream on` from behaving one way in the TUI and another in the listener.
 * - **The explicit-configuration gate is here, not in the launcher.** R-5.9.4
 *   says nothing may dream before the user has configured it (permission
 *   included), so `/dream run` answers "finish setup" before touching S5.
 *   "Configured" is *explicitly written* `dreamEnabled` + `dreamPermissionMode`
 *   — the defaults a resolver fills in are not a decision the user made.
 *
 * The status face reads only settings, the hidden run records and the ledger
 * (R-5.7.6 / route §2.5): no new protocol command, no scheduler state.
 */

import { getConversationId } from "@/agent/context";
import {
  type AppendDreamNoteResult,
  appendNote,
  clearNotes,
  DREAM_NOTE_MAX_QUEUE,
  DREAM_NOTE_MAX_TEXT_CHARS,
  type DreamNote,
  listNotes,
  removeNote,
} from "@/agent/dream/dream-notes";
import { readDreamPressure } from "@/agent/dream/dream-pressure";
import type { DreamCommandScope } from "@/agent/reflection-runs";
import { getBackend } from "@/backend";
import type { CommandHandle } from "@/cli/commands/runner";
import {
  DREAM_COMMAND_SPECS,
  formatSubcommandUsage,
  hasSubcommand,
} from "@/cli/commands/subcommand-specs";
import {
  ensureDreamTask,
  type StartDreamRunInput,
  type StartDreamRunResult,
  startDreamRun,
} from "@/cli/helpers/dream-launcher";
import {
  DETAIL_COST_DECIMALS,
  formatCost,
  UNKNOWN_VALUE,
} from "@/cli/helpers/usage-format";
import {
  type DreamIdleWindow,
  type ResolvedDreamSettings,
  readDreamSettings,
  type StoredDreamSettings,
  updateDreamSettings,
} from "@/dream-settings";
import { settingsManager } from "@/settings-manager";
import { readConversationProvenance } from "@/types/conversation-provenance";
import {
  DREAM_TIERS,
  type DreamRunStatus,
  type DreamTriggerSource,
} from "@/types/dream-run-metadata";
import { readScheduledRunUsage } from "@/usage/ledger";

/** How many hidden conversations the status face scans for run records. */
const DREAM_RUN_SCAN_LIMIT = 50;

/** The status face's most recent runs, newest first. */
const RECENT_RUN_LIMIT = 3;

/**
 * One run record projected for display. The authoritative shape is
 * `DreamRunMetadata`; this is the subset the command and the list header read,
 * and it is deliberately flat so a caller (or a test) can hand one in.
 */
export interface DreamRunRow {
  runId: string;
  status: DreamRunStatus;
  triggerSource: DreamTriggerSource;
  startedAt: number;
  endedAt: number | null;
  budgetTokens: number;
  spentTokens: number;
  reportPath: string | null;
  handoff: string | null;
}

/** One run's ledger aggregate, as the status face paints it. */
export interface DreamRunCost {
  /** Ledger rows for the run; `0` means "no ledger row", painted `—`. */
  turns: number;
  /** Summed provider cost, or `null` when no row was priced. */
  cost: number | null;
}

/** The subset of the command runner this module needs (one row per command). */
export interface DreamCommandRunner {
  start(input: string, output: string): CommandHandle;
}

/** Everything the action needs; the defaults are the production readers. */
export interface DreamCommandDeps {
  agentId: string;
  /**
   * The conversation the command was typed in, recorded on a note's `source`.
   * Optional because the registry path can answer before a conversation is
   * current; the note simply carries no source then.
   */
  conversationId?: string | null;
  commandRunner?: DreamCommandRunner;
  /** Raise the Settings page. Returns `false` when the shell has no pages. */
  openSettings?: () => boolean;
  /**
   * Raise the first-run wizard. Returns `false` when it cannot be raised, in
   * which case `/dream on` falls back to writing the switch and naming the
   * missing setup.
   */
  openWizard?: (commandInput: string) => boolean;
  readSettings?: (agentId: string) => ResolvedDreamSettings;
  isConfigured?: (agentId: string) => boolean;
  writeSettings?: (patch: StoredDreamSettings) => void;
  readPressure?: (agentId: string) => number;
  readRuns?: (agentId: string) => Promise<readonly DreamRunRow[]>;
  readUsage?: (
    runIds: readonly string[],
  ) => Promise<ReadonlyMap<string, DreamRunCost>>;
  startRun?: (input: StartDreamRunInput) => Promise<StartDreamRunResult>;
  /**
   * Make sure the agent has its dream carrier task (T1's `ensureDreamTask`).
   * Injected by tests so no unit test has to write the schedule store.
   */
  ensureTask?: (agentId: string) => unknown;
  /** Queue readers/writers for `/dream note…`; injected by tests. */
  readNotes?: (agentId: string) => Promise<readonly DreamNote[]>;
  appendNote?: (
    agentId: string,
    input: {
      text: string;
      author: "user";
      source?: { conversationId?: string };
    },
  ) => Promise<AppendDreamNoteResult>;
  removeNote?: (agentId: string, id: string) => Promise<boolean>;
  clearNotes?: (agentId: string) => Promise<number>;
  now?: () => Date;
}

interface ResolvedDeps {
  agentId: string;
  conversationId: string | null;
  commandRunner: DreamCommandRunner | null;
  openSettings: (() => boolean) | null;
  openWizard: ((commandInput: string) => boolean) | null;
  readSettings: (agentId: string) => ResolvedDreamSettings;
  isConfigured: (agentId: string) => boolean;
  writeSettings: (patch: StoredDreamSettings) => void;
  readPressure: (agentId: string) => number;
  readRuns: (agentId: string) => Promise<readonly DreamRunRow[]>;
  readUsage: (
    runIds: readonly string[],
  ) => Promise<ReadonlyMap<string, DreamRunCost>>;
  startRun: (input: StartDreamRunInput) => Promise<StartDreamRunResult>;
  ensureTask: (agentId: string) => unknown;
  readNotes: (agentId: string) => Promise<readonly DreamNote[]>;
  appendNote: (
    agentId: string,
    input: {
      text: string;
      author: "user";
      source?: { conversationId?: string };
    },
  ) => Promise<AppendDreamNoteResult>;
  removeNote: (agentId: string, id: string) => Promise<boolean>;
  clearNotes: (agentId: string) => Promise<number>;
  now: () => Date;
}

function resolveDeps(deps: DreamCommandDeps): ResolvedDeps {
  return {
    agentId: deps.agentId,
    conversationId:
      deps.conversationId !== undefined
        ? deps.conversationId
        : getConversationId(),
    commandRunner: deps.commandRunner ?? null,
    openSettings: deps.openSettings ?? null,
    openWizard: deps.openWizard ?? null,
    readSettings: deps.readSettings ?? readDreamSettings,
    isConfigured: deps.isConfigured ?? isDreamConfigured,
    writeSettings:
      deps.writeSettings ?? ((patch) => updateDreamSettings(patch)),
    readPressure: deps.readPressure ?? readDreamPressure,
    readRuns: deps.readRuns ?? readDreamRunRows,
    readUsage: deps.readUsage ?? readDreamRunCosts,
    startRun: deps.startRun ?? startDreamRun,
    ensureTask: deps.ensureTask ?? ((agentId) => ensureDreamTask(agentId)),
    readNotes: deps.readNotes ?? listNotes,
    appendNote: deps.appendNote ?? appendNote,
    removeNote: deps.removeNote ?? removeNote,
    clearNotes: deps.clearNotes ?? clearNotes,
    now: deps.now ?? (() => new Date()),
  };
}

// ── Configuration gate (R-5.9.4) ────────────────────────────────────

/**
 * Whether the user has *explicitly* configured dream for this agent.
 *
 * The resolver fills every knob from defaults, so "resolved settings exist" is
 * not the same question as "the user decided". R-5.9.4 makes the second one the
 * hard gate, and it names the permission tier, so both keys must have been
 * written: a bare `true` from a settings file is not a configured run.
 */
export function isDreamConfigured(agentId?: string): boolean {
  try {
    const record = settingsManager.getSettings() as unknown as Record<
      string,
      unknown
    >;
    const overrides = record.dreamSettingsByAgent;
    const override =
      agentId && typeof overrides === "object" && overrides !== null
        ? (overrides as Record<string, unknown>)[agentId]
        : undefined;
    const overrideRecord =
      typeof override === "object" && override !== null
        ? (override as Record<string, unknown>)
        : {};
    const permission =
      overrideRecord.permissionMode ?? record.dreamPermissionMode;
    const enabled = overrideRecord.enabled ?? record.dreamEnabled;
    return permission !== undefined && enabled !== undefined;
  } catch {
    // An uninitialized settings manager means "nothing was configured yet".
    return false;
  }
}

// ── Run records and ledger spend ─────────────────────────────────────

/**
 * The hidden conversations that carry a dream run record, newest run first.
 *
 * Read from the hidden-session list the same way the viewer does; the run
 * record lives on the conversation so this needs no sidecar and no protocol
 * command (R-5.7.6). Unreadable records are skipped by the projection, which is
 * what keeps one corrupt record from taking the status face down.
 */
async function readDreamRunRows(
  agentId: string,
): Promise<readonly DreamRunRow[]> {
  try {
    const listed = await getBackend().listConversations({
      agent_id: agentId,
      hidden_only: true,
      limit: DREAM_RUN_SCAN_LIMIT,
    });
    const runs: DreamRunRow[] = [];
    for (const conversation of listed) {
      const dream = readConversationProvenance(conversation).dream;
      if (!dream) continue;
      runs.push({
        runId: dream.runId,
        status: dream.status,
        triggerSource: dream.triggerSource,
        startedAt: dream.startedAt,
        endedAt: dream.endedAt,
        budgetTokens: dream.budgetTokens,
        spentTokens: dream.spentTokens,
        reportPath: dream.reportPath,
        handoff: dream.handoff,
      });
    }
    runs.sort((left, right) => right.startedAt - left.startedAt);
    return runs;
  } catch {
    // A backend that cannot be read is "no runs", not a failed status line:
    // the settings half of the answer is still true and worth showing.
    return [];
  }
}

/** Ledger spend per run, through the ledger's own per-run API. */
async function readDreamRunCosts(
  runIds: readonly string[],
): Promise<ReadonlyMap<string, DreamRunCost>> {
  const wanted = [...new Set(runIds.filter((runId) => runId.length > 0))];
  const costs = new Map<string, DreamRunCost>();
  if (wanted.length === 0) return costs;
  try {
    const summaries = await readScheduledRunUsage({ runIds: wanted });
    for (const runId of wanted) {
      const summary = summaries.get(runId);
      costs.set(runId, {
        turns: summary?.turns ?? 0,
        cost:
          summary && summary.turns > 0 && summary.cost
            ? summary.cost.total
            : null,
      });
    }
  } catch {
    for (const runId of wanted) costs.set(runId, { turns: 0, cost: null });
  }
  return costs;
}

// ── Status wording (shared with the hidden-session list header) ─────

/** The run status as a reader sees it. `budget_exhausted` is not `failed`. */
export function dreamRunStatusLabel(status: DreamRunStatus): string {
  switch (status) {
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "timeout":
      return "timeout";
    case "cancelled":
      return "cancelled";
    case "budget_exhausted":
      return "budget exhausted";
    case "unfinished":
      return "unfinished";
    case "running":
      return "running";
  }
}

/**
 * Whether a persisted status counts as a failed run (R-5.7.5's "failed only").
 * `budget_exhausted` and `cancelled` are deliberate stops, not failures: the
 * route opens its failure matrix by saying budget exhaustion is not counted.
 */
export function isDreamRunFailure(status: DreamRunStatus): boolean {
  return status === "failed" || status === "timeout" || status === "unfinished";
}

/** A timestamp in the terms the status face reads in; `null` is unknown. */
export function formatDreamRunTime(
  at: number | null,
  now: number = Date.now(),
): string {
  if (at === null || !Number.isFinite(at)) return "time unknown";
  const elapsed = Math.max(0, now - at);
  const minute = 60_000;
  if (elapsed < minute) return "just now";
  if (elapsed < 60 * minute) return `${Math.floor(elapsed / minute)}m ago`;
  if (elapsed < 24 * 60 * minute) {
    return `${Math.floor(elapsed / (60 * minute))}h ago`;
  }
  return `${Math.floor(elapsed / (24 * 60 * minute))}d ago`;
}

const integerFormat = new Intl.NumberFormat("en-US");

function tokens(value: number): string {
  return integerFormat.format(Math.max(0, Math.trunc(value)));
}

/** `—` for a missing cost, never `$ 0.00` (R-5.7.3 / usage-format rule 1). */
export function formatDreamRunCostLabel(
  cost: DreamRunCost | undefined,
): string {
  if (!cost || cost.turns === 0) return UNKNOWN_VALUE;
  return formatCost(cost.cost ?? undefined, DETAIL_COST_DECIMALS);
}

/** `22:00–07:00, 12:00–13:00`; English copy uses the en dash. */
function idleWindowsLabel(settings: ResolvedDreamSettings): string {
  if (settings.idleWindows.length === 0) return "none";
  return settings.idleWindows
    .map((window) => `${window.start}–${window.end}`)
    .join(", ");
}

function tierLabel(settings: ResolvedDreamSettings): string {
  const on = DREAM_TIERS.filter((tier) => settings.tiers[tier]);
  return on.length === DREAM_TIERS.length
    ? "all four"
    : on.length === 0
      ? "none"
      : on.join(", ");
}

// ── Actions ─────────────────────────────────────────────────────────

type DreamAction =
  | { kind: "status" }
  | { kind: "on" }
  | { kind: "off" }
  | { kind: "config" }
  | { kind: "run"; budgetOverrideTokens?: number }
  | { kind: "note-add"; text: string }
  | { kind: "note-list" }
  | { kind: "note-remove"; id: string }
  | { kind: "notes-clear" };

export type DreamActionParse = { action: DreamAction } | { error: string };

/** The command row's opening line, keyed by the action the parser produced. */
const DREAM_OPENING_LINES: Record<DreamAction["kind"], string> = {
  status: "Reading dream settings...",
  on: "Enabling dream...",
  off: "Disabling dream...",
  config: "Opening dream settings...",
  run: "Starting a dream run...",
  "note-add": "Saving a dream note...",
  "note-list": "Reading dream notes...",
  "note-remove": "Removing a dream note...",
  "notes-clear": "Clearing dream notes...",
};
/** Rendered from the spec table, so a new row cannot escape the usage line. */
const DREAM_USAGE = formatSubcommandUsage("/dream", DREAM_COMMAND_SPECS);

/** `22:00-07:00, 12:00-13:00` — the window editor's canonical form. */
export function formatDreamWindowsInput(
  windows: readonly DreamIdleWindow[],
): string {
  return windows.map((window) => `${window.start}-${window.end}`).join(", ");
}

const DREAM_WINDOW_RE =
  /^((?:[01]\d|2[0-3]):[0-5]\d)-((?:[01]\d|2[0-3]):[0-5]\d)$/;

/**
 * Parse the window editor's value; `null` when any pair is malformed.
 *
 * Deliberately stricter than `normalizeDreamIdleWindows`: that function falls
 * back to the default window so a trigger never sees an empty list, which is the
 * right runtime answer and the wrong editor answer — a typo must be reported,
 * not silently replaced.
 */
export function parseDreamWindowsInput(raw: string): DreamIdleWindow[] | null {
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) return null;
  const windows: DreamIdleWindow[] = [];
  for (const part of parts) {
    const match = DREAM_WINDOW_RE.exec(part);
    if (!match) return null;
    const start = match[1] ?? "";
    const end = match[2] ?? "";
    // start == end is neither "all day" nor "never"; the resolver drops it and
    // the editor refuses it rather than saving a window that means nothing.
    if (start === end) return null;
    windows.push({ start, end });
  }
  return windows;
}

function parseBudget(raw: string | undefined): number | undefined | null {
  if (raw === undefined || raw.trim() === "") return null;
  const value = Number(raw.trim());
  if (!Number.isFinite(value)) return null;
  const budget = Math.trunc(value);
  if (budget <= 0) return null;
  return budget;
}

/**
 * Parse the arguments after `/dream`.
 *
 * Unknown spellings report the usage line rather than being forwarded as a
 * message: a typo must not spend a run's budget.
 */
export function parseDreamAction(args: readonly string[]): DreamActionParse {
  const [subcommand, ...rest] = args;
  if (subcommand === undefined || subcommand === "") {
    return { action: { kind: "status" } };
  }
  // Membership comes from the shared table (R-02.6): this switch may only
  // spell words the completion popup also offers.
  if (!hasSubcommand(DREAM_COMMAND_SPECS, subcommand)) {
    return { error: DREAM_USAGE };
  }
  switch (subcommand) {
    case "status":
      return rest.length === 0
        ? { action: { kind: "status" } }
        : { error: DREAM_USAGE };
    case "on":
    case "off":
    case "config":
      return rest.length === 0
        ? { action: { kind: subcommand } }
        : { error: DREAM_USAGE };
    case "run": {
      let budget: number | undefined;
      for (let index = 0; index < rest.length; index += 1) {
        const arg = rest[index] ?? "";
        if (arg === "--budget") {
          const parsed = parseBudget(rest[index + 1]);
          if (parsed === null) return { error: DREAM_USAGE };
          budget = parsed;
          index += 1;
          continue;
        }
        if (arg.startsWith("--budget=")) {
          const parsed = parseBudget(arg.slice("--budget=".length));
          if (parsed === null) return { error: DREAM_USAGE };
          budget = parsed;
          continue;
        }
        return { error: DREAM_USAGE };
      }
      return { action: { kind: "run", budgetOverrideTokens: budget } };
    }
    case "note": {
      // `note remove <id>` is the one reserved spelling; every other text is
      // the note itself, so a note may contain the word "remove".
      if (rest[0] === "remove") {
        const id = rest.slice(1).join(" ").trim();
        if (id === "") return { error: DREAM_USAGE };
        return { action: { kind: "note-remove", id } };
      }
      const text = rest.join(" ").trim();
      if (text.length === 0) return { error: DREAM_USAGE };
      if (text.length > DREAM_NOTE_MAX_TEXT_CHARS) {
        return {
          error: `The dream note is ${text.length} characters; the limit is ${DREAM_NOTE_MAX_TEXT_CHARS}. Nothing was saved.`,
        };
      }
      return { action: { kind: "note-add", text } };
    }
    case "notes":
      if (rest.length === 0) return { action: { kind: "note-list" } };
      if (rest.length === 1 && rest[0] === "clear") {
        return { action: { kind: "notes-clear" } };
      }
      return { error: DREAM_USAGE };
    default:
      return { error: DREAM_USAGE };
  }
}

interface ActionResult {
  ok: boolean;
  output: string;
}

function formatStatus(
  settings: ResolvedDreamSettings,
  configured: boolean,
  pressure: number,
  runs: readonly DreamRunRow[],
  usage: ReadonlyMap<string, DreamRunCost>,
  now: Date,
): string {
  const lines: string[] = [];
  const enabledLabel = settings.enabled
    ? configured
      ? "on"
      : "on (setup incomplete)"
    : "off";
  lines.push(
    configured
      ? `Dream: ${enabledLabel}`
      : `Dream: ${enabledLabel} — run /dream on to finish setup`,
  );
  lines.push(`Permission: ${settings.permissionMode}`);
  lines.push(
    `Idle windows: ${idleWindowsLabel(settings)} · silence ${settings.silenceMinutes}m`,
  );
  const pressureText = tokens(pressure);
  const thresholdText = tokens(settings.pressureThreshold);
  const percent =
    settings.pressureThreshold > 0
      ? Math.round((pressure / settings.pressureThreshold) * 100)
      : 0;
  lines.push(
    `Pressure: ${pressureText} / ${thresholdText} (${percent}%)${
      pressure === 0 ? " — meter not wired yet (M2)" : ""
    }`,
  );
  lines.push(
    `Budget: ${tokens(settings.maxPerRun)} tokens/run · ${
      settings.maxPerDay === null
        ? "no daily cap"
        : `${tokens(settings.maxPerDay)} tokens/day`
    } · ${
      settings.timeLimitMinutes === null
        ? "no time limit"
        : `${settings.timeLimitMinutes}m limit`
    }`,
  );
  lines.push(
    `Tiers: ${tierLabel(settings)} · auto-trigger ${settings.autoTrigger ? "on" : "off"}`,
  );
  // The scheduler's own state file has no frozen reader in this milestone, so
  // the next-run estimate is honestly unavailable rather than guessed (route
  // §2.5 keeps the command to settings + records + ledger).
  lines.push("Next run: unavailable (scheduler state not exposed yet)");

  const latest = runs[0];
  if (!latest) {
    lines.push("Last run: none");
  } else {
    const cost = usage.get(latest.runId);
    lines.push(
      `Last run: ${dreamRunStatusLabel(latest.status)} · ${formatDreamRunTime(
        latest.startedAt,
        now.getTime(),
      )} · ${tokens(latest.spentTokens)} / ${tokens(latest.budgetTokens)} tokens · ${formatDreamRunCostLabel(cost)}`,
    );
    if (latest.reportPath) lines.push(`  report: ${latest.reportPath}`);
    if (latest.handoff) lines.push(`  handoff: ${latest.handoff}`);
  }
  if (runs.length > 1) {
    const recent = runs.slice(0, RECENT_RUN_LIMIT);
    const failures = recent.filter((run) =>
      isDreamRunFailure(run.status),
    ).length;
    lines.push(
      `Recent runs: ${recent.length}${failures > 0 ? ` · ${failures} failed` : ""}`,
    );
  }
  return lines.join("\n");
}

async function runStatus(deps: ResolvedDeps): Promise<ActionResult> {
  const settings = deps.readSettings(deps.agentId);
  const configured = deps.isConfigured(deps.agentId);
  const pressure = deps.readPressure(deps.agentId);
  const runs = await deps.readRuns(deps.agentId);
  const usage = await deps.readUsage(runs.map((run) => run.runId));
  return {
    ok: true,
    output: formatStatus(
      settings,
      configured,
      pressure,
      runs,
      usage,
      deps.now(),
    ),
  };
}

function runOn(deps: ResolvedDeps): ActionResult {
  const configured = deps.isConfigured(deps.agentId);
  deps.writeSettings({ enabled: true });
  const carrier = ensureDreamCarrierTask(deps);
  if (carrier.failure !== null) {
    return {
      ok: true,
      output: `Dream enabled, but the dream task could not be created: ${carrier.failure}. Automatic runs cannot trigger until it exists; run /dream on again to retry.`,
    };
  }
  // The write went to the global layer, but the resolved value is what the
  // trigger actually reads. A per-agent override can keep the agent off, and
  // saying "enabled" then would be a lie the user has no way to see.
  const resolved = deps.readSettings(deps.agentId);
  if (!resolved.enabled) {
    return {
      ok: true,
      output:
        "Dream was written to the global settings, but this agent has a per-agent override that keeps it off. Update or clear that override in Settings → Dream to make this take effect.",
    };
  }
  if (!resolved.autoTrigger) {
    return {
      ok: true,
      output:
        "Dream enabled, but automatic triggering is off. Only /dream run will start a run; turn it on in Settings → Dream to allow idle runs.",
    };
  }
  if (carrier.status !== null && carrier.status !== "active") {
    const resume = carrier.taskId
      ? `/schedule resume ${carrier.taskId}`
      : "/schedule resume";
    return {
      ok: true,
      output: `Dream enabled, but its schedule task is ${carrier.status}. Automatic runs stay off until you resume it (${resume}).`,
    };
  }
  return {
    ok: true,
    output: configured
      ? "Dream enabled. Runs will trigger in the next idle window once pressure reaches the threshold."
      : "Dream enabled. Setup is incomplete: run /dream on in the TUI to open the setup wizard.",
  };
}

/** What the carrier-task seam handed back, flattened for the enable reply. */
interface CarrierTaskOutcome {
  failure: string | null;
  taskId: string | null;
  /** The persisted task status; `null` when the seam returned no readable task. */
  status: string | null;
}

/**
 * Create the carrier task an enabled dream needs, and report the reason when it
 * cannot be created.
 *
 * The trigger is a signal source whose occurrences hang off a persisted task,
 * so on a listener-only host (no TUI tick that would create it lazily) enabling
 * dreams without one would enable nothing. That is why this runs on the explicit
 * enable rather than staying on the launcher's lazy path. Failure is returned as
 * text instead of thrown: the switch *was* written, so the user's next action is
 * "retry the task", not "dreams are off".
 */
function ensureDreamCarrierTask(deps: ResolvedDeps): CarrierTaskOutcome {
  try {
    const task = deps.ensureTask(deps.agentId);
    const record =
      typeof task === "object" && task !== null
        ? (task as Record<string, unknown>)
        : {};
    return {
      failure: null,
      taskId: typeof record.id === "string" ? record.id : null,
      status: typeof record.status === "string" ? record.status : null,
    };
  } catch (error) {
    return {
      failure: error instanceof Error ? error.message : String(error),
      taskId: null,
      status: null,
    };
  }
}

function runOff(deps: ResolvedDeps): ActionResult {
  deps.writeSettings({ enabled: false });
  return { ok: true, output: "Dream disabled." };
}

function runConfig(deps: ResolvedDeps): ActionResult {
  if (deps.openSettings?.()) {
    const configured = deps.isConfigured(deps.agentId);
    return {
      ok: true,
      output: configured
        ? "Dream settings are in Settings → Dream."
        : "Dream settings are in Settings → Dream. Setup is incomplete; run /dream on for the wizard.",
    };
  }
  return {
    ok: false,
    output:
      "Dream settings are in the Settings page (full-screen TUI: /experiments → full-screen TUI, then restart). Setup: /dream on.",
  };
}

async function runRun(
  deps: ResolvedDeps,
  budget?: number,
): Promise<ActionResult> {
  if (!deps.isConfigured(deps.agentId)) {
    return {
      ok: false,
      output:
        "Dream is not configured yet. Run /dream on to finish setup (permission, windows, budget) before starting a run.",
    };
  }
  const settings = deps.readSettings(deps.agentId);
  if (!settings.enabled) {
    return {
      ok: false,
      output: "Dream is off. Run /dream on first.",
    };
  }
  const result = await deps.startRun({
    agentId: deps.agentId,
    ...(budget !== undefined ? { budgetOverrideTokens: budget } : {}),
  });
  if (!result.started) {
    return {
      ok: false,
      output: `Dream run did not start: ${result.reason ?? "unknown reason"}.`,
    };
  }
  const budgetLabel =
    budget === undefined ? "" : ` with a ${tokens(budget)}-token budget`;
  return {
    ok: true,
    output: `Dream run${result.runId ? ` ${result.runId}` : ""} started${budgetLabel}. You will get a reminder when it finishes.`,
  };
}

// ── Notes (F-06 §2.3) ───────────────────────────────────────────────

/** One line of the list: id, author, age and a bounded summary. */
const NOTE_SUMMARY_CHARS = 80;

function noteSummary(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length <= NOTE_SUMMARY_CHARS
    ? single
    : `${single.slice(0, NOTE_SUMMARY_CHARS - 1)}…`;
}

async function runNoteAdd(
  deps: ResolvedDeps,
  text: string,
): Promise<ActionResult> {
  const appended = await deps.appendNote(deps.agentId, {
    text,
    author: "user",
    ...(deps.conversationId
      ? { source: { conversationId: deps.conversationId } }
      : {}),
  });
  if (!appended.ok) {
    // The queue's own refusal text is the honest answer: it says *why* nothing
    // was saved (full, too long), which a generic failure would hide.
    return { ok: false, output: appended.error };
  }
  return {
    ok: true,
    output: `Added dream note ${appended.note.id}. The next dream run reads it before its ordinary tidy work.`,
  };
}

async function runNoteList(deps: ResolvedDeps): Promise<ActionResult> {
  const notes = await deps.readNotes(deps.agentId);
  if (notes.length === 0) {
    return {
      ok: true,
      output: "No pending dream notes. Add one with /dream note <text>.",
    };
  }
  const now = deps.now().getTime();
  const lines = [
    `Dream notes: ${notes.length} pending (max ${DREAM_NOTE_MAX_QUEUE})`,
  ];
  for (const note of notes) {
    lines.push(
      `  ${note.id} · ${note.author} · ${formatDreamRunTime(note.createdAt, now)} · ${noteSummary(note.text)}`,
    );
  }
  return { ok: true, output: lines.join("\n") };
}

async function runNoteRemove(
  deps: ResolvedDeps,
  id: string,
): Promise<ActionResult> {
  const removed = await deps.removeNote(deps.agentId, id);
  if (!removed) {
    return {
      ok: false,
      output: `No dream note matches "${id}". Run /dream notes to list the queue.`,
    };
  }
  return { ok: true, output: `Removed dream note ${id}.` };
}

async function runNotesClear(deps: ResolvedDeps): Promise<ActionResult> {
  const cleared = await deps.clearNotes(deps.agentId);
  if (cleared === 0) {
    return { ok: true, output: "There were no dream notes to clear." };
  }
  return {
    ok: true,
    output: `Cleared ${cleared} dream note${cleared === 1 ? "" : "s"}.`,
  };
}

async function runDreamAction(
  action: DreamAction,
  deps: ResolvedDeps,
): Promise<ActionResult> {
  switch (action.kind) {
    case "status":
      return runStatus(deps);
    case "on":
      return runOn(deps);
    case "off":
      return runOff(deps);
    case "config":
      return runConfig(deps);
    case "run":
      return runRun(deps, action.budgetOverrideTokens);
    case "note-add":
      return runNoteAdd(deps, action.text);
    case "note-list":
      return runNoteList(deps);
    case "note-remove":
      return runNoteRemove(deps, action.id);
    case "notes-clear":
      return runNotesClear(deps);
  }
}

/**
 * `/dream` from the submit path: owns its command row, and raises an overlay
 * when the action is a UI one (the overlay then owns the row).
 */
export async function handleDreamSlashCommand(
  input: string,
  deps: DreamCommandDeps,
): Promise<{ submitted: boolean }> {
  const resolved = resolveDeps(deps);
  const commandRunner = resolved.commandRunner;
  if (!commandRunner) {
    throw new Error("Dream commands need a command runner in the TUI.");
  }
  const args = input
    .trim()
    .replace(/^\/dream\b/, "")
    .trim();
  const parsed = parseDreamAction(args === "" ? [] : args.split(/\s+/));
  if ("error" in parsed) {
    commandRunner.start(input, parsed.error).fail(parsed.error);
    return { submitted: true };
  }

  const { action } = parsed;
  // First explicit enable is the setup wizard (requirement R-5.9.2): it writes
  // the permission tier and the budget that make a run legal, so the switch is
  // not flipped before it succeeds. The wizard is raised *before* a command row
  // exists because `openOverlay` starts the row itself — a second row for the
  // same keystroke would double-print.
  if (
    action.kind === "on" &&
    !resolved.isConfigured(resolved.agentId) &&
    resolved.openWizard?.(input)
  ) {
    return { submitted: true };
  }

  const cmd = commandRunner.start(input, DREAM_OPENING_LINES[action.kind]);
  try {
    const result = await runDreamAction(action, resolved);
    if (result.ok) cmd.finish(result.output, true);
    else cmd.fail(result.output);
  } catch (error) {
    cmd.fail(
      `Dream command failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { submitted: true };
}

/**
 * `/dream` through the registry (any shell, including the quick one-line
 * receipt in the append shell): the same action, no overlay effects.
 *
 * `overrides` exists for the focused tests — the production readers touch the
 * settings singleton and the backend, which a unit test should not — and is
 * unused by the registry call site.
 */
export async function handleDreamCommand(
  args: string[],
  scope?: DreamCommandScope,
  overrides: Omit<DreamCommandDeps, "agentId"> = {},
): Promise<string> {
  if (!scope?.agentId) throw new Error("Dream requires an active agent.");
  const parsed = parseDreamAction(args);
  if ("error" in parsed) return parsed.error;
  const result = await runDreamAction(
    parsed.action,
    resolveDeps({
      ...overrides,
      agentId: scope.agentId,
      ...(scope.conversationId ? { conversationId: scope.conversationId } : {}),
    }),
  );
  return result.output;
}
