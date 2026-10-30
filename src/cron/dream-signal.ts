/**
 * Dream signal source (F-06 M1, requirement §5.2 / R-5.2.1–R-5.2.9).
 *
 * The dream task is a recurring schedule record whose `cron` field is a
 * placeholder: the cron source never evaluates it (`type === "dream"` is
 * skipped there, route C-37) and this source is the only writer of dream
 * occurrences. A dream becomes due when all of the following hold:
 *
 * - the master switch is on and automatic triggering is enabled (`/dream run`
 *   bypasses this source entirely),
 * - at least one tier is enabled (a run with every tier off has nothing to do),
 * - the wall clock is inside one of the configured idle windows — several
 *   windows per day are legal and a window whose end is earlier than its start
 *   crosses midnight (R-5.2.1),
 * - the agent has been silent for `silenceMinutes` (R-5.2.2),
 * - pressure reached `pressureThreshold` (R-5.2.3; the formula is S3's, this
 *   module only compares against the resolved threshold),
 * - fewer than {@link DREAM_MAX_ATTEMPTS_PER_DAY} attempts were produced today,
 * - the cooldown `nextEligibleAt` has elapsed, and
 * - no dream run for this agent is active.
 *
 * ## Why the state lives in its own file (route C-18)
 *
 * `signal_state.cursor` is one global string per source, rewritten on every
 * tick under the schedule lock, and two hosts can tick the same store. The
 * per-agent per-day counters and the cooldown are dream state, so they live in
 * `<harness home>/dream/signal-state.json`, addressed per agent. This module is
 * the only owner of that file; the scheduler core still owns the task cursor
 * (`last_consumed_occurrence`), which every source leaves alone.
 *
 * ## Purity and the write protocol
 *
 * `evaluate` is **read-only**: it decides "is this agent due now" from the state
 * file and the deps and never writes. Advancing the counters is the short-lived
 * dream host's job (`markDreamAttempt` at run start, `deferDreamSignal` when a
 * delegated child re-checks and finds the conditions are gone), so a tick can
 * be evaluated by the preflight probe, by the TUI host and by the listener
 * without racing each other over the day counter (R-5.2.5's `nextEligibleAt`).
 *
 * Occurrences are ephemeral: each evaluation mints `dream:<iso>#<n>`, the
 * scheduler defers it (the host delegates `dream run --task`), and the child
 * mints its own occurrence when it actually starts. Nothing here consumes a
 * task cursor.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ResolvedDreamSettings } from "@/dream-settings";
import { appHomePath } from "@/utils/app-paths";
import type {
  DueOccurrence,
  ScheduleTaskV2,
  SignalEvaluation,
  SignalSource,
  SignalState,
} from "./cron-types";
import { parseDreamTaskPayload } from "./dream-task";
import { listSignalSources, registerSignalSource } from "./signal";

export const DREAM_SIGNAL_SOURCE_ID = "dream";

/**
 * Placeholder cron for dream tasks. It is a real, valid five-field expression
 * (January 1st, 00:00) so the store's validation accepts it, but the cron source
 * skips `dream` tasks, so it never fires. The value is frozen and exported so
 * the `/dream` config flow (M4) and the launcher create compatible records.
 */
export const DREAM_PLACEHOLDER_CRON = "0 0 1 1 *";

/** R-5.2.5: at most six self-advances per local day. */
export const DREAM_MAX_ATTEMPTS_PER_DAY = 6;

/**
 * R-5.2.5: after a declined or produced attempt the next evaluation may only
 * try again this much later (`nextEligibleAt`, default now + 10 minutes).
 */
export const DREAM_ATTEMPT_COOLDOWN_MINUTES = 10;

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_DAY = 24 * 60;

/** A single in-flight dream run, mirrored into the state file. */
export interface DreamRunMarker {
  runId: string;
  startedAt: number;
}

/** The per-agent state this source reads and the dream host advances. */
export interface DreamSignalState {
  /** Local day (`YYYY-MM-DD`) the counters below belong to. */
  dayKey: string | null;
  /** Attempts produced today by the automatic trigger. */
  dayCount: number;
  /** Epoch ms before which no new attempt may be produced. */
  nextEligibleAt: number | null;
  /** Last occurrence key this source minted (diagnostics / `/dream status`). */
  lastOccurrence: string | null;
  /** Epoch ms of the last started attempt (manual or automatic). */
  lastAttemptAt: number | null;
  /** Terminal outcome of the last finished run, when the host recorded one. */
  lastOutcome: string | null;
  /** Set while a short-lived dream host owns a run. */
  running: DreamRunMarker | null;
}

export const EMPTY_DREAM_SIGNAL_STATE: DreamSignalState = {
  dayKey: null,
  dayCount: 0,
  nextEligibleAt: null,
  lastOccurrence: null,
  lastAttemptAt: null,
  lastOutcome: null,
  running: null,
};

/**
 * The read seam the frozen `DreamSignalDeps` documents (route §2.3): every dep
 * is a synchronous read, so a scheduler tick can evaluate without I/O awaits.
 *
 * `readState` takes the agent id because one registered source evaluates every
 * agent's dream task; `readSettingsForAgent` is an additive optional dep for the
 * per-agent settings map (M0) — when absent, `readSettings()` is used.
 */
export interface DreamSignalDeps {
  readState(agentId: string): DreamSignalState;
  readSettings(): ResolvedDreamSettings;
  readSettingsForAgent?(agentId: string): ResolvedDreamSettings;
  readPressure(agentId: string): number;
  readLastActiveAt(agentId: string): number | null;
  isRunning(agentId: string): boolean;
  now(): Date;
}

/** Why the source did or did not produce an occurrence (order of the checks). */
export type DreamSkipReason =
  | "eligible"
  | "not_dream_task"
  | "not_active"
  | "disabled"
  | "auto_trigger_off"
  | "all_tiers_off"
  | "outside_window"
  | "daily_limit"
  | "cooldown"
  | "already_running"
  | "user_active"
  | "low_pressure";

export interface DreamEligibilityInput {
  task: ScheduleTaskV2;
  settings: ResolvedDreamSettings;
  state: DreamSignalState;
  now: Date;
  /**
   * S3 pressure. A function is accepted so the expensive read (usage ledger +
   * memFS stats) only happens when the cheap gates (window, day counter,
   * cooldown) have already passed — R-5.2.4 wants a lightweight per-tick
   * evaluation, and a call outside the window must not touch the ledger.
   */
  pressure: number | (() => number);
  /**
   * Last user interaction for the agent (S2); `null` = none recorded. Also
   * accepts a thunk for the same reason as `pressure`.
   */
  lastActiveAt: number | null | (() => number | null);
  isRunning: boolean;
}

export interface DreamEligibility {
  eligible: boolean;
  reason: DreamSkipReason;
  /** Earliest instant this agent may be evaluated again, when known. */
  nextEligibleAt: number | null;
}

// ── Run marker liveness (cron-side) ─────────────────────────────────

/**
 * A `running` marker older than this can no longer be trusted as "a run is
 * alive". The floor is one hour; a run with a configured time limit gets its
 * limit plus a 30-minute grace, and a run with no limit (the default) is
 * assumed dead after 24.5 hours — the marker is a breadcrumb, not a lock.
 */
export const DREAM_MARKER_MIN_STALE_MS = 60 * 60_000;

/** Grace added on top of a configured time limit before a marker is stale. */
export const DREAM_MARKER_LIMIT_GRACE_MINUTES = 30;

/** Assumed run length when the agent configured no time limit. */
export const DREAM_MARKER_DEFAULT_LIMIT_MINUTES = 24 * 60;

/** How long a `running` marker stays authoritative for the trigger. */
export function dreamRunMarkerStaleAfterMs(
  settings: Pick<ResolvedDreamSettings, "timeLimitMinutes">,
): number {
  const limitMinutes =
    settings.timeLimitMinutes ?? DREAM_MARKER_DEFAULT_LIMIT_MINUTES;
  return Math.max(
    DREAM_MARKER_MIN_STALE_MS,
    (limitMinutes + DREAM_MARKER_LIMIT_GRACE_MINUTES) * MS_PER_MINUTE,
  );
}

/**
 * True when the state file's in-flight marker should still suppress a new
 * trigger. A marker left by a killed process would otherwise deadlock the
 * agent forever (there is no production path that clears it before the next
 * run, and the next run is exactly what the marker suppresses); the age bound
 * makes that self-healing. T2's `isDreamRunLive` adds the authoritative
 * lease-owner check on the host side.
 */
export function isDreamRunMarkerActive(
  marker: DreamRunMarker | null,
  settings: Pick<ResolvedDreamSettings, "timeLimitMinutes">,
  now: Date,
): boolean {
  if (!marker) return false;
  const startedAt = Number.isFinite(marker.startedAt) ? marker.startedAt : 0;
  return now.getTime() - startedAt < dreamRunMarkerStaleAfterMs(settings);
}

// ── Windows ─────────────────────────────────────────────────────────

/** `HH:mm` → minutes since local midnight; `null` when unparseable. */
export function parseDreamWindowMinute(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function localMinuteOfDay(at: Date): number {
  return at.getHours() * 60 + at.getMinutes();
}

/** True when `at` falls inside any configured window (cross-midnight aware). */
export function isWithinDreamIdleWindow(
  windows: readonly { start: string; end: string }[],
  at: Date,
): boolean {
  const minute = localMinuteOfDay(at);
  for (const window of windows) {
    const start = parseDreamWindowMinute(window.start);
    const end = parseDreamWindowMinute(window.end);
    // An unparseable or empty window never matches; a full-day window is
    // rejected by the settings normalizer, so start === end means "empty".
    if (start === null || end === null || start === end) continue;
    if (start < end) {
      if (minute >= start && minute < end) return true;
    } else if (minute >= start || minute < end) {
      return true;
    }
  }
  return false;
}

/**
 * Epoch ms of the next start of any window strictly after `at` (local time).
 * `null` when no window is configured.
 */
export function nextDreamWindowStart(
  windows: readonly { start: string; end: string }[],
  at: Date,
): number | null {
  const minute = localMinuteOfDay(at);
  let best: number | null = null;
  for (const window of windows) {
    const start = parseDreamWindowMinute(window.start);
    if (start === null) continue;
    const offset =
      start > minute ? start - minute : start + MINUTES_PER_DAY - minute;
    const candidate = at.getTime() + offset * MS_PER_MINUTE;
    if (best === null || candidate < best) best = candidate;
  }
  return best;
}

/** Local `YYYY-MM-DD` key used by the per-day counter. */
export function dreamDayKey(at: Date): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(
    at.getDate(),
  ).padStart(2, "0")}`;
}

// ── Eligibility ─────────────────────────────────────────────────────

/**
 * Apply the day rollover without writing: a state whose `dayKey` is not today
 * counts as zero attempts for today (R-5.2.5 "次日顺延").
 *
 * `nextEligibleAt` is an absolute instant and is preserved: a cooldown that
 * crosses midnight (a cross-midnight window) must still be honoured, and a
 * stale value in the past has no effect.
 */
export function rollDreamStateForDay(
  state: DreamSignalState,
  now: Date,
): DreamSignalState {
  const today = dreamDayKey(now);
  if (state.dayKey === today) return state;
  return {
    ...state,
    dayKey: today,
    dayCount: 0,
  };
}

/**
 * The whole trigger rule in one place. Callers use it for evaluating the
 * signal, for the delegated child's second check (route §2.2 "二次校验") and
 * for the read-only status surfaces, so the three can never disagree.
 */
export function evaluateDreamEligibility(
  input: DreamEligibilityInput,
): DreamEligibility {
  const { task, settings, now } = input;
  if (task.type !== "dream") {
    return { eligible: false, reason: "not_dream_task", nextEligibleAt: null };
  }
  if (task.status !== "active") {
    return { eligible: false, reason: "not_active", nextEligibleAt: null };
  }
  // R-5.9.4 / Q-43: explicit configuration is the hard gate, and enabling the
  // master switch is that configuration; auto-trigger is a second opt-in.
  if (!settings.enabled) {
    return { eligible: false, reason: "disabled", nextEligibleAt: null };
  }
  if (!settings.autoTrigger) {
    return {
      eligible: false,
      reason: "auto_trigger_off",
      nextEligibleAt: null,
    };
  }
  if (!Object.values(settings.tiers).some(Boolean)) {
    return { eligible: false, reason: "all_tiers_off", nextEligibleAt: null };
  }

  const nowMs = now.getTime();
  const nextWindow = nextDreamWindowStart(settings.idleWindows, now);
  if (!isWithinDreamIdleWindow(settings.idleWindows, now)) {
    return {
      eligible: false,
      reason: "outside_window",
      nextEligibleAt: nextWindow,
    };
  }

  const state = rollDreamStateForDay(input.state, now);
  if (state.dayCount >= DREAM_MAX_ATTEMPTS_PER_DAY) {
    // "超出或窗口结束则 nextEligibleAt＝次日窗口开始": the day's six attempts
    // are spent, so the next attempt is at the next window start.
    return {
      eligible: false,
      reason: "daily_limit",
      nextEligibleAt: nextWindow,
    };
  }
  if (state.nextEligibleAt !== null && state.nextEligibleAt > nowMs) {
    return {
      eligible: false,
      reason: "cooldown",
      nextEligibleAt: state.nextEligibleAt,
    };
  }
  // `isRunning` is the caller's liveness answer (production: marker age bound,
  // host: lease-owner check). A raw `state.running` fallback here would undo the
  // age bound and let a crash remnant deadlock the trigger again (Lead fix).
  if (input.isRunning) {
    return { eligible: false, reason: "already_running", nextEligibleAt: null };
  }

  // R-5.2.2: silence since the last interaction. `null` means "no interaction
  // was recorded in this process" — there is nothing the user is waiting on, so
  // the silence requirement is satisfied (a recorded recent interaction is the
  // only thing that can block a run). The S2 read is lazy: it runs only after
  // every cheap gate above has passed.
  const lastActiveAt =
    typeof input.lastActiveAt === "function"
      ? input.lastActiveAt()
      : input.lastActiveAt;
  if (lastActiveAt !== null) {
    const silentMs = settings.silenceMinutes * MS_PER_MINUTE;
    if (nowMs - lastActiveAt < silentMs) {
      return { eligible: false, reason: "user_active", nextEligibleAt: null };
    }
  }

  // The S3 read is the expensive one (usage ledger + memFS); same laziness.
  const pressure =
    typeof input.pressure === "function" ? input.pressure() : input.pressure;
  if (!(pressure >= settings.pressureThreshold)) {
    return { eligible: false, reason: "low_pressure", nextEligibleAt: null };
  }
  return { eligible: true, reason: "eligible", nextEligibleAt: nowMs };
}

/** Occurrence key; monotonic per task and unique per attempt (R-5.2.5). */
export function dreamOccurrenceKey(now: Date, state: DreamSignalState): string {
  return `dream:${now.toISOString()}#${state.dayCount + 1}`;
}

// ── State file ──────────────────────────────────────────────────────

interface DreamSignalFile {
  version: 1;
  agents: Record<string, DreamSignalState>;
}

const STATE_FILE_VERSION = 1;

/** `<harness home>/dream/signal-state.json` — never a literal `.haruyuki`. */
export function getDreamSignalStatePath(): string {
  return appHomePath(["dream", "signal-state.json"]);
}

function emptySignalFile(): DreamSignalFile {
  return { version: STATE_FILE_VERSION, agents: {} };
}

function readSignalFile(): DreamSignalFile {
  try {
    const raw = readFileSync(getDreamSignalStatePath(), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return emptySignalFile();
    const agents = (parsed as { agents?: unknown }).agents;
    if (typeof agents !== "object" || agents === null) return emptySignalFile();
    return {
      version: STATE_FILE_VERSION,
      agents: agents as Record<string, DreamSignalState>,
    };
  } catch {
    // A missing file is the normal first-run case; a corrupt one is treated the
    // same as empty — the counters are advisory, the task cursor is the truth.
    return emptySignalFile();
  }
}

function writeSignalFile(file: DreamSignalFile): void {
  const path = getDreamSignalStatePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.tmp-${process.pid}`;
    writeFileSync(temp, JSON.stringify(file, null, 2));
    // Rename is atomic on both NTFS and POSIX, so a reader never sees a partial
    // state file while a run advances its counters.
    renameSync(temp, path);
  } catch {
    // The signal is advisory: a read-only harness home must not crash a tick.
  }
}

function normalizeSignalState(value: unknown): DreamSignalState {
  if (typeof value !== "object" || value === null)
    return { ...EMPTY_DREAM_SIGNAL_STATE };
  const record = value as Record<string, unknown>;
  const number = (key: string): number | null =>
    typeof record[key] === "number" && Number.isFinite(record[key])
      ? (record[key] as number)
      : null;
  const runningRaw = record.running;
  const running =
    typeof runningRaw === "object" &&
    runningRaw !== null &&
    typeof (runningRaw as { runId?: unknown }).runId === "string"
      ? {
          runId: (runningRaw as { runId: string }).runId,
          startedAt:
            typeof (runningRaw as { startedAt?: unknown }).startedAt ===
            "number"
              ? (runningRaw as { startedAt: number }).startedAt
              : 0,
        }
      : null;
  return {
    dayKey: typeof record.dayKey === "string" ? record.dayKey : null,
    dayCount:
      typeof record.dayCount === "number" && Number.isFinite(record.dayCount)
        ? Math.max(0, Math.trunc(record.dayCount))
        : 0,
    nextEligibleAt: number("nextEligibleAt"),
    lastOccurrence:
      typeof record.lastOccurrence === "string" ? record.lastOccurrence : null,
    lastAttemptAt: number("lastAttemptAt"),
    lastOutcome:
      typeof record.lastOutcome === "string" ? record.lastOutcome : null,
    running,
  };
}

/** Read one agent's state; a missing/corrupt file yields the empty state. */
export function readDreamSignalState(agentId: string): DreamSignalState {
  return normalizeSignalState(readSignalFile().agents[agentId]);
}

/** Replace one agent's state, preserving every other agent's row. */
export function writeDreamSignalState(
  agentId: string,
  state: DreamSignalState,
): void {
  const file = readSignalFile();
  file.agents[agentId] = state;
  writeSignalFile(file);
}

// ── State transitions (the dream host owns these) ───────────────────

export interface DreamAttemptInput {
  agentId: string;
  now: Date;
  occurrence: string;
  /** Manual runs bypass the trigger, so they do not spend the daily budget. */
  manual: boolean;
}

/**
 * Record that an attempt started (R-5.2.5).
 *
 * Automatic attempts advance the day counter and the cooldown; a manual
 * `/dream run` only marks the last attempt, so it neither eats one of the six
 * automatic self-advances nor throttles the automatic trigger.
 */
export function markDreamAttempt(input: DreamAttemptInput): DreamSignalState {
  const rolled = rollDreamStateForDay(
    readDreamSignalState(input.agentId),
    input.now,
  );
  const next: DreamSignalState = {
    ...rolled,
    lastAttemptAt: input.now.getTime(),
    lastOccurrence: input.occurrence,
    running: null,
  };
  if (!input.manual) {
    next.dayCount = rolled.dayCount + 1;
    next.nextEligibleAt =
      input.now.getTime() + DREAM_ATTEMPT_COOLDOWN_MINUTES * MS_PER_MINUTE;
  }
  writeDreamSignalState(input.agentId, next);
  return next;
}

/**
 * R-5.2.5: a delegated child re-checked and found the conditions gone. Push
 * `nextEligibleAt` so the short-lived host does not spawn another child on the
 * next tick, and point at the next window when the reason is window/day based.
 */
export function deferDreamSignal(input: {
  agentId: string;
  now: Date;
  reason: DreamSkipReason;
  settings: ResolvedDreamSettings;
}): DreamSignalState {
  const rolled = rollDreamStateForDay(
    readDreamSignalState(input.agentId),
    input.now,
  );
  const nextWindow = nextDreamWindowStart(
    input.settings.idleWindows,
    input.now,
  );
  let nextEligibleAt =
    input.now.getTime() + DREAM_ATTEMPT_COOLDOWN_MINUTES * MS_PER_MINUTE;
  if (input.reason === "outside_window" || input.reason === "daily_limit") {
    nextEligibleAt = nextWindow ?? nextEligibleAt;
  }
  const next: DreamSignalState = {
    ...rolled,
    nextEligibleAt,
  };
  writeDreamSignalState(input.agentId, next);
  return next;
}

/** Mark a run as in flight (the signal then stops producing occurrences). */
export function markDreamRunActive(
  agentId: string,
  runId: string,
  at: Date,
): void {
  const state = readDreamSignalState(agentId);
  writeDreamSignalState(agentId, {
    ...state,
    running: { runId, startedAt: at.getTime() },
  });
}

/** Clear the in-flight marker in a terminal path (`finally`). */
export function markDreamRunFinished(
  agentId: string,
  outcome: string,
  at: Date,
): void {
  const state = readDreamSignalState(agentId);
  writeDreamSignalState(agentId, {
    ...rollDreamStateForDay(state, at),
    running: null,
    lastOutcome: outcome,
  });
}

// ── The signal source ───────────────────────────────────────────────

function settingsFor(
  deps: DreamSignalDeps,
  agentId: string,
): ResolvedDreamSettings {
  if (deps.readSettingsForAgent) return deps.readSettingsForAgent(agentId);
  return deps.readSettings();
}

function stateFor(deps: DreamSignalDeps, agentId: string): DreamSignalState {
  return deps.readState(agentId);
}

/**
 * When the scheduler core could productively evaluate this agent again. Used by
 * the preflight probe and the host's jitter wake, never to decide a run.
 */
function nextActionAt(
  task: ScheduleTaskV2,
  settings: ResolvedDreamSettings,
  state: DreamSignalState,
  now: Date,
): Date | null {
  if (task.type !== "dream" || task.status !== "active") return null;
  if (!settings.enabled || !settings.autoTrigger) return null;
  if (!Object.values(settings.tiers).some(Boolean)) return null;
  const nowMs = now.getTime();
  const rolled = rollDreamStateForDay(state, now);
  const nextWindow = nextDreamWindowStart(settings.idleWindows, now);
  if (!isWithinDreamIdleWindow(settings.idleWindows, now)) {
    return nextWindow === null ? null : new Date(nextWindow);
  }
  if (rolled.dayCount >= DREAM_MAX_ATTEMPTS_PER_DAY) {
    return nextWindow === null ? null : new Date(nextWindow);
  }
  if (rolled.nextEligibleAt !== null && rolled.nextEligibleAt > nowMs) {
    return new Date(rolled.nextEligibleAt);
  }
  if (rolled.running !== null) return null;
  // Eligible right now: the 60 s tick is the wake-up; no jitter hint needed.
  return null;
}

/**
 * Build the registered source. Deps are injected so the unit tests can drive
 * windows/pressure/silence without a settings file or a usage ledger; the
 * production wiring is `createDefaultDreamSignalDeps()` in
 * `cron/dream-signal-deps.ts`.
 */
export function createDreamSignalSource(deps: DreamSignalDeps): SignalSource {
  return {
    id: DREAM_SIGNAL_SOURCE_ID,
    evaluate(input: {
      now: Date;
      tasks: ScheduleTaskV2[];
      state: SignalState;
    }): SignalEvaluation {
      // The per-agent dream state is ours; the shared `signal_state` cursors
      // belong to the core (C-18), so this source returns no cursor.
      void input.state;
      const occurrences: DueOccurrence[] = [];
      for (const task of input.tasks) {
        if (task.type !== "dream" || task.status !== "active") continue;
        const settings = settingsFor(deps, task.agentId);
        const state = stateFor(deps, task.agentId);
        const eligibility = evaluateDreamEligibility({
          task,
          settings,
          state,
          now: input.now,
          // Thunks, not values: outside the window / disabled / daily-limit /
          // cooldown early returns must not read the ledger or the activity file
          // (R-5.2.4 "lightweight evaluation").
          pressure: () => deps.readPressure(task.agentId),
          lastActiveAt: () => deps.readLastActiveAt(task.agentId),
          isRunning: deps.isRunning(task.agentId),
        });
        if (!eligibility.eligible) continue;
        occurrences.push({
          taskId: task.id,
          occurrence: dreamOccurrenceKey(
            input.now,
            rollDreamStateForDay(state, input.now),
          ),
          intendedAt: input.now.toISOString(),
          missedCycles: 1,
        });
      }
      return { occurrences };
    },
    nextDueAt(input: { now: Date; tasks: ScheduleTaskV2[] }): Date | null {
      let earliest: Date | null = null;
      for (const task of input.tasks) {
        if (task.type !== "dream" || task.status !== "active") continue;
        const dueAt = nextActionAt(
          task,
          settingsFor(deps, task.agentId),
          stateFor(deps, task.agentId),
          input.now,
        );
        if (!dueAt) continue;
        if (!earliest || dueAt.getTime() < earliest.getTime()) earliest = dueAt;
      }
      return earliest;
    },
  };
}

/** True when a dream source is already registered (production or a test stub). */
export function isDreamSignalSourceRegistered(): boolean {
  return listSignalSources().some(
    (source) => source.id === DREAM_SIGNAL_SOURCE_ID,
  );
}

/**
 * Register the source idempotently, unless one is already registered.
 *
 * Presence-guarded rather than replacing: every host calls this on its tick,
 * and a test that registered deps with a stub pressure reader must not have
 * them overwritten by the next tick.
 */
export function ensureDreamSignalSourceRegistered(deps: DreamSignalDeps): void {
  if (isDreamSignalSourceRegistered()) return;
  registerSignalSource(createDreamSignalSource(deps));
}

/**
 * The dream task shape every run requires (R-5.3.4, route C-17/C-37). Shared by
 * the core's pre-start check and the short-lived host's second check so the two
 * cannot drift; returns `null` when the task is runnable.
 */
export function validateDreamTaskForRun(task: ScheduleTaskV2): string | null {
  if (task.type !== "dream") return "not a dream task";
  if (!task.recurring) return "a dream task must be recurring";
  if (task.target.kind !== "new" || !task.target.hidden) {
    return "a dream task must target a new hidden conversation";
  }
  if (task.timeoutMinutes !== 0) {
    return `a dream task must set timeout_minutes to 0 (got ${task.timeoutMinutes}); the default 30-minute timeout would silently cut a long run`;
  }
  if (task.cron !== DREAM_PLACEHOLDER_CRON) {
    return `a dream task must use the placeholder cron "${DREAM_PLACEHOLDER_CRON}"`;
  }
  if (parseDreamTaskPayload(task.payload) === undefined) {
    return "the dream task payload is malformed (expected a JSON DreamTaskPayload)";
  }
  return null;
}
