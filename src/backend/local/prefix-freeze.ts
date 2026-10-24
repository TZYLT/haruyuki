import { existsSync } from "node:fs";
import type { LocalAgentRecord } from "./local-store";
import { gitOutput } from "./memory-git";
import {
  appendCompiledSkillsBlock,
  compileAvailableSkillsBlock,
  getCommittedMemfsRevision,
  hashRawSystemPrompt,
  type LocalCompiledSystemPrompt,
  type LocalFreezeReason,
} from "./system-prompt-compilation";

/**
 * Strict prefix freeze.
 *
 * Within a conversation the applied prefix snapshot — the compiled system
 * prompt, the skills block, the tool declarations, and the model/sampling
 * settings — is never rewritten by a turn. A memfs commit, an `agent.system`
 * edit, a skills/tool change, or a `/model` switch only becomes pending; it is
 * applied at an application point: a new conversation, compaction, an explicit
 * `/recompile`, or (by inheritance) a fork.
 *
 * A conversation that has no snapshot yet (first turn, or an old record without
 * one) compiles it once and applies it from then on. Collections that a
 * conversation cannot know at compile time (client tools/skills arrive with the
 * first turn body) are established on the first turn that carries a non-empty
 * set, and stay frozen until the next application point.
 *
 * This module owns the freeze decision, the snapshot assembly, and the pending
 * report so the orchestration in `local-backend.ts` stays readable and the
 * rules are unit-testable on their own.
 */

function sortForCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForCanonical);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortForCanonical(record[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Deterministic JSON: object keys sorted recursively so the same declaration set
 * serializes to the same bytes regardless of key insertion order. Prefix
 * stability depends on this, not just on set equality.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortForCanonical(value)) ?? "null";
}

/**
 * Stamp application-point freeze metadata onto a freshly compiled snapshot.
 * The compiled snapshot carries no frozen collections, so tools/skills stay
 * "unfrozen" here and are re-established from the next turn's live set — which
 * is exactly "apply the latest live collections".
 */
export function stampFreezeMetadata(
  compiled: LocalCompiledSystemPrompt,
  input: {
    reason: LocalFreezeReason;
    agent: Pick<LocalAgentRecord, "model" | "model_settings">;
    now?: Date;
  },
): LocalCompiledSystemPrompt {
  return {
    ...compiled,
    freezeSchema: 1,
    frozenAt: (input.now ?? new Date()).toISOString(),
    frozenReason: input.reason,
    frozenModel: input.agent.model,
    frozenModelSettings: canonicalJson(input.agent.model_settings),
  };
}

/**
 * Establish (once, from the first non-empty live set) and observe the frozen
 * collections. `changed` reports whether the persisted snapshot must be
 * rewritten: a collection was just frozen, a live value differing from the
 * frozen one was observed, or an earlier observation no longer differs.
 *
 * The live values are always computed, so "the client stopped sending tools"
 * is an observation (an empty set) rather than an absence of information. An
 * observation that matches the frozen value is CLEARED: otherwise `/context pending`
 * would keep reporting drift that has since reverted.
 */
export function establishFrozenCollections(input: {
  snapshot: LocalCompiledSystemPrompt;
  skillsBlock: string;
  tools: unknown[];
}): { snapshot: LocalCompiledSystemPrompt; changed: boolean } {
  const snapshot = { ...input.snapshot };
  let changed = false;

  const liveTools = canonicalJson(input.tools);
  if (snapshot.frozenTools === undefined) {
    if (input.tools.length > 0) {
      snapshot.frozenTools = liveTools;
      changed = true;
    }
  } else if (liveTools === snapshot.frozenTools) {
    if (snapshot.observedTools !== undefined) {
      delete snapshot.observedTools;
      changed = true;
    }
  } else if (snapshot.observedTools !== liveTools) {
    snapshot.observedTools = liveTools;
    changed = true;
  }

  const liveSkillsBlock = input.skillsBlock;
  if (snapshot.frozenSkillsBlock === undefined) {
    if (liveSkillsBlock.length > 0) {
      snapshot.frozenSkillsBlock = liveSkillsBlock;
      changed = true;
    }
  } else if (liveSkillsBlock === snapshot.frozenSkillsBlock) {
    if (snapshot.observedSkillsBlock !== undefined) {
      delete snapshot.observedSkillsBlock;
      changed = true;
    }
  } else if (snapshot.observedSkillsBlock !== liveSkillsBlock) {
    snapshot.observedSkillsBlock = liveSkillsBlock;
    changed = true;
  }

  return { snapshot, changed };
}

export interface FrozenTurnPrefix {
  systemPrompt: string;
  agent: LocalAgentRecord;
  clientTools?: unknown[];
  snapshot: LocalCompiledSystemPrompt;
  /** True when the persisted snapshot must be rewritten (freeze/observe). */
  changed: boolean;
}

/**
 * Assemble the turn prefix from the applied snapshot: append the frozen skills
 * block, overlay the frozen model/params, and hand back the frozen tool set.
 * Establishes the collections on the first turn that carries a non-empty set.
 */
export function assembleFrozenTurnPrefix(input: {
  snapshot: LocalCompiledSystemPrompt;
  liveAgent: LocalAgentRecord;
  clientSkills: unknown[];
  clientTools: unknown[];
}): FrozenTurnPrefix {
  const established = establishFrozenCollections({
    snapshot: input.snapshot,
    skillsBlock: compileAvailableSkillsBlock(input.clientSkills),
    tools: input.clientTools,
  });
  const frozenTools = frozenToolsArray(established.snapshot);
  return {
    systemPrompt: appendCompiledSkillsBlock(
      established.snapshot.content,
      established.snapshot.frozenSkillsBlock,
    ),
    agent: applyFrozenAgentOverrides(input.liveAgent, established.snapshot),
    ...(frozenTools !== undefined ? { clientTools: frozenTools } : {}),
    snapshot: established.snapshot,
    changed: established.changed,
  };
}

/** The frozen tool declaration set, or `undefined` when tools are not frozen yet
 * (so the caller falls back to the request body's live `client_tools`).
 */
export function frozenToolsArray(
  snapshot: LocalCompiledSystemPrompt,
): unknown[] | undefined {
  if (snapshot.frozenTools === undefined) return undefined;
  try {
    const parsed = JSON.parse(snapshot.frozenTools);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Overlay the frozen model/params so a live `/model` switch does not take effect. */
export function applyFrozenAgentOverrides<
  T extends Pick<LocalAgentRecord, "model" | "model_settings">,
>(agent: T, snapshot: LocalCompiledSystemPrompt): T {
  if (
    snapshot.frozenModel === undefined &&
    snapshot.frozenModelSettings === undefined
  ) {
    return agent;
  }
  let modelSettings = agent.model_settings;
  if (snapshot.frozenModelSettings !== undefined) {
    try {
      const parsed = JSON.parse(snapshot.frozenModelSettings);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        modelSettings = parsed as Record<string, unknown>;
      }
    } catch {
      // Keep the live settings if the frozen blob is unreadable.
    }
  }
  return {
    ...agent,
    ...(snapshot.frozenModel !== undefined
      ? { model: snapshot.frozenModel }
      : {}),
    model_settings: modelSettings,
  };
}

// --- pending report -------------------------------------------------------

export interface ContextPendingMemory {
  appliedRevision?: string;
  committedRevision?: string;
  /**
   * Whether the committed revision could actually be read. `false` means the
   * memory repo is missing or unreadable, so the memory delta is UNKNOWN rather
   * than empty — the caller must say so instead of reporting "no changes".
   * `undefined` means memory is not in play at all (memfs disabled).
   */
  reachable?: boolean;
  /** `git log --oneline <applied>..<committed>` entries. */
  unappliedCommits: string[];
  diffStat: string;
  fullDiff?: string;
}

export interface ContextPendingToolsDiff {
  applied?: string;
  observed?: string;
  added: string[];
  removed: string[];
  changed: boolean;
}

export interface ContextPendingReport {
  hasSnapshot: boolean;
  memory: ContextPendingMemory;
  systemChanged: boolean;
  skillsChanged: boolean;
  tools: ContextPendingToolsDiff;
  model: { applied?: string; live?: string; changed: boolean };
  modelSettingsChanged: boolean;
  dirty: boolean;
  hasPending: boolean;
}

export interface ComputeContextPendingInput {
  hasSnapshot: boolean;
  appliedRevision?: string;
  committedRevision?: string;
  memoryReachable?: boolean;
  unappliedCommits?: string[];
  diffStat?: string;
  fullDiff?: string;
  appliedRawSystemHash?: string;
  liveRawSystemHash?: string;
  appliedSkillsBlock?: string;
  observedSkillsBlock?: string;
  appliedTools?: string;
  observedTools?: string;
  appliedModel?: string;
  liveModel?: string;
  appliedModelSettings?: string;
  liveModelSettings?: string;
  dirty: boolean;
}

function toolNames(toolsJson: string | undefined): Set<string> {
  if (toolsJson === undefined) return new Set();
  try {
    const parsed = JSON.parse(toolsJson);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed
        .map((tool) =>
          tool && typeof tool === "object"
            ? (tool as { name?: unknown }).name
            : undefined,
        )
        .filter((name): name is string => typeof name === "string"),
    );
  } catch {
    return new Set();
  }
}

export function computeContextPending(
  input: ComputeContextPendingInput,
): ContextPendingReport {
  const memoryChanged =
    input.appliedRevision !== undefined &&
    input.committedRevision !== undefined &&
    input.appliedRevision !== input.committedRevision;

  const systemChanged =
    input.appliedRawSystemHash !== undefined &&
    input.liveRawSystemHash !== undefined &&
    input.appliedRawSystemHash !== input.liveRawSystemHash;

  const skillsChanged =
    input.appliedSkillsBlock !== undefined &&
    input.observedSkillsBlock !== undefined &&
    input.appliedSkillsBlock !== input.observedSkillsBlock;

  const appliedNames = toolNames(input.appliedTools);
  const observedNames = toolNames(input.observedTools);
  const added = [...observedNames]
    .filter((name) => !appliedNames.has(name))
    .sort();
  const removed = [...appliedNames]
    .filter((name) => !observedNames.has(name))
    .sort();
  const toolsChanged =
    input.observedTools !== undefined &&
    input.appliedTools !== undefined &&
    input.observedTools !== input.appliedTools;

  const modelChanged =
    input.appliedModel !== undefined &&
    input.liveModel !== undefined &&
    input.appliedModel !== input.liveModel;

  const modelSettingsChanged =
    input.appliedModelSettings !== undefined &&
    input.liveModelSettings !== undefined &&
    input.appliedModelSettings !== input.liveModelSettings;

  return {
    hasSnapshot: input.hasSnapshot,
    memory: {
      ...(input.appliedRevision !== undefined
        ? { appliedRevision: input.appliedRevision }
        : {}),
      ...(input.committedRevision !== undefined
        ? { committedRevision: input.committedRevision }
        : {}),
      ...(input.memoryReachable !== undefined
        ? { reachable: input.memoryReachable }
        : {}),
      unappliedCommits: input.unappliedCommits ?? [],
      diffStat: input.diffStat ?? "",
      ...(input.fullDiff !== undefined ? { fullDiff: input.fullDiff } : {}),
    },
    systemChanged,
    skillsChanged,
    tools: {
      ...(input.appliedTools !== undefined
        ? { applied: input.appliedTools }
        : {}),
      ...(input.observedTools !== undefined
        ? { observed: input.observedTools }
        : {}),
      added,
      removed,
      changed: toolsChanged,
    },
    model: {
      ...(input.appliedModel !== undefined
        ? { applied: input.appliedModel }
        : {}),
      ...(input.liveModel !== undefined ? { live: input.liveModel } : {}),
      changed: modelChanged,
    },
    modelSettingsChanged,
    dirty: input.dirty,
    hasPending:
      memoryChanged ||
      systemChanged ||
      skillsChanged ||
      toolsChanged ||
      modelChanged ||
      modelSettingsChanged,
  };
}

/**
 * Assemble the pending report from already-gathered live data. The caller owns
 * I/O (git, store); this keeps the backend orchestration thin (D-009).
 */
export function buildContextPendingReport(input: {
  snapshot: LocalCompiledSystemPrompt | undefined;
  liveAgent: Pick<LocalAgentRecord, "system" | "model" | "model_settings">;
  memory: ContextPendingMemory;
  dirty: boolean;
}): ContextPendingReport {
  const { snapshot } = input;
  return computeContextPending({
    hasSnapshot: snapshot !== undefined,
    appliedRevision: snapshot?.memfsRevision,
    committedRevision: input.memory.committedRevision,
    memoryReachable: input.memory.reachable,
    unappliedCommits: input.memory.unappliedCommits,
    diffStat: input.memory.diffStat,
    fullDiff: input.memory.fullDiff,
    appliedRawSystemHash: snapshot?.systemTemplateHash,
    liveRawSystemHash: hashRawSystemPrompt(input.liveAgent.system),
    appliedSkillsBlock: snapshot?.frozenSkillsBlock,
    observedSkillsBlock: snapshot?.observedSkillsBlock,
    appliedTools: snapshot?.frozenTools,
    observedTools: snapshot?.observedTools,
    appliedModel: snapshot?.frozenModel,
    liveModel: input.liveAgent.model,
    appliedModelSettings: snapshot?.frozenModelSettings,
    liveModelSettings: canonicalJson(input.liveAgent.model_settings),
    dirty: input.dirty,
  });
}

/**
 * Uncommitted working-tree changes in the memory repo. Deliberately NOT part of
 * `hasPending`: they are not applied until committed (requirement §3.1, §5).
 */
export function isMemoryDirDirty(memoryDir: string): boolean {
  if (!existsSync(memoryDir)) return false;
  try {
    return gitOutput(memoryDir, ["status", "--porcelain"]).trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Read the committed-vs-applied memory delta straight from git. Best effort: a
 * missing repo or unreachable revision yields an empty delta rather than
 * throwing, because the caller must never rewrite the prefix on error. The
 * `reachable` flag records that the delta is UNKNOWN, so the report can say so
 * instead of claiming there is nothing pending.
 */
export function collectMemoryPending(
  memoryDir: string,
  appliedRevision: string | undefined,
  options: { full?: boolean } = {},
): ContextPendingMemory {
  const committedRevision = existsSync(memoryDir)
    ? getCommittedMemfsRevision(memoryDir)
    : undefined;
  const reachable = committedRevision !== undefined;
  const base: ContextPendingMemory = {
    ...(appliedRevision !== undefined ? { appliedRevision } : {}),
    ...(committedRevision !== undefined ? { committedRevision } : {}),
    reachable,
    unappliedCommits: [],
    diffStat: "",
  };
  if (
    appliedRevision === undefined ||
    committedRevision === undefined ||
    appliedRevision === committedRevision
  ) {
    return base;
  }
  const range = `${appliedRevision}..${committedRevision}`;
  let unappliedCommits: string[] = [];
  let diffStat = "";
  try {
    unappliedCommits = gitOutput(memoryDir, ["log", "--oneline", range])
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    diffStat = gitOutput(memoryDir, [
      "diff",
      "--stat",
      appliedRevision,
      committedRevision,
    ]).trimEnd();
  } catch {
    return base;
  }
  // The full diff is requested separately and can be far larger than the commit
  // list or the stat: a failure there must not discard the two we already have.
  let fullDiff: string | undefined;
  if (options.full) {
    try {
      fullDiff = gitOutput(memoryDir, [
        "diff",
        appliedRevision,
        committedRevision,
      ]).trimEnd();
    } catch {
      fullDiff = undefined;
    }
  }
  return {
    ...base,
    unappliedCommits,
    diffStat,
    ...(fullDiff !== undefined ? { fullDiff } : {}),
  };
}
