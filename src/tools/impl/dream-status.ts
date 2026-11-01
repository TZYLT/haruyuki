/**
 * `DreamStatus` — the dream run's read-only self-check (F-06 R-5.3.5 / Q-56,
 * route §2.3 M3).
 *
 * The run is unattended: nobody is around to tell the model how much budget is
 * left or which tier it is on. The reminder messages the parent writes are the
 * primary channel; this tool is the fallback the requirement keeps when that
 * channel cannot be delivered, and it is also the honest answer to "how much
 * time do I have" mid-run.
 *
 * Read-only by construction: it reads the conversation record (the run
 * metadata) and the resolved settings, and returns text. It never writes the
 * record, the run state or the memory repository, and it never advances the
 * budget.
 */
import { getConversationId, getCurrentAgentId } from "@/agent/context";
import { getBackend } from "@/backend";
import type { ResolvedDreamSettings } from "@/dream-settings";
import { readDreamSettings } from "@/dream-settings";
import { getRuntimeContext } from "@/runtime-context";
import {
  DREAM_TIERS,
  type DreamRunMetadata,
  type DreamTier,
  readDreamRunMetadata,
} from "@/types/dream-run-metadata";
import { isRecord } from "@/utils/type-guards";

const TOOL_NAME = "DreamStatus";

/**
 * Tokens one continue-step is expected to cost, used only to turn "tokens left"
 * into "roughly how many more steps".
 *
 * There is no per-step counter on the frozen run record, so any step count is
 * an estimate; the constant is exported so the number is reviewable and the
 * output always labels it as an estimate.
 */
export const DREAM_STATUS_TOKENS_PER_STEP_ESTIMATE = 2_000;

export interface DreamStatusDeps {
  backend?: { retrieveConversation(conversationId: string): Promise<unknown> };
  agentId?: string;
  conversationId?: string;
  settings?: ResolvedDreamSettings;
  /** Milliseconds since epoch; tests pin it, production reads the clock. */
  now?: number;
}

export interface DreamStatusResult {
  content: string;
  status: "success" | "error";
}

/** Everything this tool can say, before the text is laid out. */
export interface DreamStatusSnapshot {
  metadata: DreamRunMetadata;
  settings: ResolvedDreamSettings;
  remainingTokens: number;
  spentPercent: number;
  remainingTiers: DreamTier[];
  estimatedRemainingSteps: number;
  elapsedMinutes: number;
  remainingMinutes: number | null;
}

function error(content: string): DreamStatusResult {
  return { content, status: "error" };
}

function formatTokens(value: number): string {
  return value.toLocaleString("en-US");
}

function formatMinutes(minutes: number): string {
  const rounded = Math.max(0, Math.round(minutes));
  if (rounded < 60) return `${rounded}m`;
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return rest === 0 ? `${hours}h` : `${hours}h${rest}m`;
}

function resolveAgentId(deps: DreamStatusDeps): string | null {
  if (deps.agentId) return deps.agentId;
  const runtimeAgentId = getRuntimeContext()?.agentId;
  if (typeof runtimeAgentId === "string" && runtimeAgentId.length > 0) {
    return runtimeAgentId;
  }
  try {
    return getCurrentAgentId();
  } catch {
    return null;
  }
}

function resolveConversationId(deps: DreamStatusDeps): string | null {
  if (deps.conversationId) return deps.conversationId;
  const runtimeConversationId = getRuntimeContext()?.conversationId;
  if (
    typeof runtimeConversationId === "string" &&
    runtimeConversationId.length > 0
  ) {
    return runtimeConversationId;
  }
  try {
    return getConversationId();
  } catch {
    return null;
  }
}

/**
 * Turn the run record plus the settings into the numbers the model needs.
 *
 * Pure so the budget math and tier progress are testable without a backend.
 * `remainingTokens` never goes negative, `spentPercent` is clamped to 100, and
 * `estimatedRemainingSteps` uses the documented per-step estimate.
 */
export function buildDreamStatusSnapshot(input: {
  metadata: DreamRunMetadata;
  settings: ResolvedDreamSettings;
  now: number;
}): DreamStatusSnapshot {
  const { metadata, settings, now } = input;
  const remainingTokens = Math.max(
    0,
    metadata.budgetTokens - metadata.spentTokens,
  );
  const spentPercent =
    metadata.budgetTokens > 0
      ? Math.min(
          100,
          Math.floor((metadata.spentTokens / metadata.budgetTokens) * 100),
        )
      : 100;
  const reachedIndex =
    metadata.tierReached === null
      ? -1
      : DREAM_TIERS.indexOf(metadata.tierReached);
  const remainingTiers = metadata.tierPlan.filter(
    (tier) => DREAM_TIERS.indexOf(tier) > reachedIndex,
  );
  const elapsedMinutes = Math.max(0, (now - metadata.startedAt) / 60_000);
  const remainingMinutes =
    metadata.timeLimitMinutes === null
      ? null
      : Math.max(0, metadata.timeLimitMinutes - elapsedMinutes);
  return {
    metadata,
    settings,
    remainingTokens,
    spentPercent,
    remainingTiers,
    estimatedRemainingSteps: Math.floor(
      remainingTokens / DREAM_STATUS_TOKENS_PER_STEP_ESTIMATE,
    ),
    elapsedMinutes,
    remainingMinutes,
  };
}

/** The budgeting hint the reminder channel and this tool must agree on. */
export function dreamStatusHint(spentPercent: number): string {
  if (spentPercent >= 100) {
    return "Budget exhausted: stop starting new work, commit what is coherent, and call DreamDone with a handoff.";
  }
  if (spentPercent >= 90) {
    return "Over 90% of the budget is spent: make only the commits that must happen, then call DreamDone with a handoff.";
  }
  if (spentPercent >= 75) {
    return "Over 75% of the budget is spent: start wrapping up — finish the current change, commit it, and do not open new work.";
  }
  if (spentPercent >= 40) {
    return "Over 40% of the budget is spent: prefer finishing and committing what you started over opening new work.";
  }
  return "Budget is comfortable: continue with the current tier, committing coherent changes as you go.";
}

function formatTierPlan(snapshot: DreamStatusSnapshot): string {
  const plan =
    snapshot.metadata.tierPlan.length > 0
      ? snapshot.metadata.tierPlan.join(" → ")
      : "(all tiers disabled)";
  const reached = snapshot.metadata.tierReached ?? "none yet";
  const remaining =
    snapshot.remainingTiers.length > 0
      ? snapshot.remainingTiers.join(", ")
      : "none";
  return [
    `- tiers planned: ${plan}`,
    `- tier reached: ${reached}`,
    `- tiers remaining: ${remaining}`,
  ].join("\n");
}

function renderSnapshot(snapshot: DreamStatusSnapshot, now: number): string {
  const { metadata, settings } = snapshot;
  const started = new Date(metadata.startedAt).toISOString().slice(0, 16);
  const handoff =
    metadata.handoff === null ? "(no handoff recorded yet)" : metadata.handoff;
  const disabledTiers = DREAM_TIERS.filter((tier) => !settings.tiers[tier]);
  return [
    `${TOOL_NAME} · run ${metadata.runId} (${metadata.triggerSource} trigger, started ${started} UTC)`,
    `- status: ${metadata.status}`,
    `- budget: ${formatTokens(metadata.budgetTokens)} tokens; spent ${formatTokens(metadata.spentTokens)} (${snapshot.spentPercent}%); remaining ${formatTokens(snapshot.remainingTokens)}`,
    formatTierPlan(snapshot),
    `- estimated remaining steps: ~${snapshot.estimatedRemainingSteps} (estimate only: about ${formatTokens(DREAM_STATUS_TOKENS_PER_STEP_ESTIMATE)} tokens per step)`,
    `- elapsed: ${formatMinutes(snapshot.elapsedMinutes)}; time limit: ${
      metadata.timeLimitMinutes === null
        ? "none"
        : `${formatMinutes(metadata.timeLimitMinutes)} (${formatMinutes(snapshot.remainingMinutes ?? 0)} left)`
    }`,
    `- handoff: ${handoff}`,
    disabledTiers.length > 0
      ? `- disabled tiers: ${disabledTiers.join(", ")}`
      : null,
    `\n${dreamStatusHint(snapshot.spentPercent)}`,
    "\nThis tool is read-only. It has not changed the run record, the budget or the memory repository.",
    `(check time: ${new Date(now).toISOString()})`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/**
 * Report budget, tier progress, remaining steps and the handoff hint for the
 * current dream run.
 */
export async function dream_status(
  _args: Record<string, unknown>,
  deps: DreamStatusDeps = {},
): Promise<DreamStatusResult> {
  const agentId = resolveAgentId(deps);
  if (agentId === null) {
    return error(
      `${TOOL_NAME}: no agent is available in this execution context, so there is no dream run to inspect.`,
    );
  }
  const conversationId = resolveConversationId(deps);
  if (conversationId === null) {
    return error(
      `${TOOL_NAME}: no conversation is available in this execution context, so there is no dream run to inspect.`,
    );
  }

  const backend = deps.backend ?? getBackend();
  let record: unknown;
  try {
    record = await backend.retrieveConversation(conversationId);
  } catch {
    return error(
      `${TOOL_NAME}: conversation "${conversationId}" was not found, so there is no dream run to inspect.`,
    );
  }
  const metadata = readDreamRunMetadata(
    isRecord(record) ? record.dream : undefined,
  );
  if (metadata === undefined) {
    return error(
      `${TOOL_NAME}: conversation "${conversationId}" is not a dream run (it carries no run record). ${TOOL_NAME} only works inside the hidden conversation a dream run created.`,
    );
  }

  const settings = deps.settings ?? readDreamSettings(agentId);
  const now = deps.now ?? Date.now();
  const snapshot = buildDreamStatusSnapshot({ metadata, settings, now });
  return { content: renderSnapshot(snapshot, now), status: "success" };
}
