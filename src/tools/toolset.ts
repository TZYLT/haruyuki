import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { getModelProviderType } from "@/agent/available-models";
import { resolveModel } from "@/agent/model";
import { resolveModelHandleFromLlmConfig } from "@/agent/model-handles";
import type { SkillSource } from "@/agent/skill-sources";
import { getBackend } from "@/backend";
import { buildModInvocationContext } from "@/mods/context";
import type { ModEvents } from "@/mods/event-emitter";
import type { ModAdapter } from "@/mods/mod-adapter";
import type { ModPermissionDefinition } from "@/mods/permission-registry";
import type { ModToolDefinition } from "@/mods/tool-registry";
import type { ModContext } from "@/mods/types";
import type { RuntimeContextSnapshot } from "@/runtime-context";
import { settingsManager } from "@/settings-manager";
import { readConversationProvenance } from "@/types/conversation-provenance";
import type { DreamTier } from "@/types/dream-run-metadata";
import { OPENAI_COMPATIBLE_PROXY_UPDATE_ARG } from "@/utils/openai-endpoint";
import {
  DREAM_RUN_ID_ENV,
  DREAM_TIER_ENV,
} from "@/utils/subagent-launch-marker";
import { isRecord } from "@/utils/type-guards";
import { getStoredClientPreferences } from "./client-preferences";
import {
  DREAM_REQUIRED_TOOL_NAMES,
  DREAM_TOOL_NAMES,
} from "./dream-tool-names";
import { INTERACTIVE_USER_INPUT_TOOL_NAMES } from "./interactive-policy";
import {
  getInternalToolName,
  isOpenAIModel,
  loadTools,
  type PreparedToolExecutionContext,
  prepareToolExecutionContextForModel,
} from "./manager";
import type { PermissionModeState } from "./permission-mode-state";
import { isRemovedToolName } from "./removed-tools";
import { TOOL_DEFINITIONS, type ToolName } from "./tool-definitions";
import type { ToolsetName, ToolsetPreference } from "./toolset-types";

export type { ToolsetName, ToolsetPreference } from "./toolset-types";

export interface ClientToolsetConfig {
  /** Request-scoped base toolset. Omitted preserves the runtime preference. */
  base?: ToolsetPreference;
  /** Additional bundled client tools to load before applying the allowlist. */
  include?: string[];
}

const DREAM_TIERS: readonly DreamTier[] = ["tidy", "think", "task", "wander"];

/**
 * The dream run context a dream child inherited from its launcher (F-06 W7).
 *
 * A tier turn is a separate process: the parent sets `HARUYUKI_DREAM_TIER` /
 * `HARUYUKI_DREAM_RUN_ID` when it spawns the child, and this reads them back so
 * `MemoryCommit` can prefix the commit (`dream(<tier>):`) and the review-mark
 * tool can address the run. An unknown tier or empty id is ignored rather than
 * trusted; a non-dream process never calls this.
 */
export function readDreamRunContext(env: NodeJS.ProcessEnv): {
  dreamTier?: DreamTier;
  dreamRunId?: string;
} {
  const tier = env[DREAM_TIER_ENV]?.trim() as DreamTier | undefined;
  const dreamTier =
    tier !== undefined && DREAM_TIERS.includes(tier) ? tier : undefined;
  const dreamRunId = env[DREAM_RUN_ID_ENV]?.trim();
  return {
    ...(dreamTier !== undefined ? { dreamTier } : {}),
    ...(dreamRunId ? { dreamRunId } : {}),
  };
}

function resolveIncludedToolNames(toolNames: string[] | undefined): ToolName[] {
  if (!toolNames) return [];

  return toolNames.map((toolName) => {
    const internalName = getInternalToolName(toolName);
    if (!Object.hasOwn(TOOL_DEFINITIONS, internalName)) {
      throw new Error(
        isRemovedToolName(toolName)
          ? `Unknown bundled client tool: ${toolName} (removed from Haruyuki)`
          : `Unknown bundled client tool: ${toolName}`,
      );
    }
    return internalName as ToolName;
  });
}

/**
 * Provider types whose models speak the OpenAI API and should use the codex
 * toolset regardless of handle prefix. Handles are unreliable here: BYOK and
 * managed providers use arbitrary prefixes (e.g. "lc-openai/gpt-6-astra",
 * "chatgpt-work/gpt-5.5"), so the provider type is the authoritative signal.
 */
const OPENAI_PROVIDER_TYPES = new Set([
  "openai",
  "openai-codex",
  "chatgpt_oauth",
]);

export function deriveToolsetFromModel(
  modelIdentifier: string,
  providerType?: string | null,
  options?: { openAICompatibleProxy?: boolean | null },
): "codex" | "default" {
  // Generic OpenAI-compatible endpoints also report provider_type "openai"
  // (with the openai_compatible_proxy marker in model_settings) but may serve
  // non-GPT models, so they keep the default toolset.
  if (
    providerType &&
    OPENAI_PROVIDER_TYPES.has(providerType) &&
    options?.openAICompatibleProxy !== true
  ) {
    return "codex";
  }
  const resolvedModel = resolveModel(modelIdentifier) ?? modelIdentifier;
  return isOpenAIModel(resolvedModel) ? "codex" : "default";
}

/** Startup uses the same preset selection and construction as each turn. */
export async function loadStartupTools(params: {
  modelIdentifier?: string;
  toolset?: ToolsetPreference;
  exclude?: ToolName[];
}): Promise<void> {
  const { modelIdentifier, toolset = "auto", exclude } = params;
  await loadTools(modelIdentifier, {
    resolvedToolset:
      toolset === "auto"
        ? deriveToolsetFromModel(modelIdentifier ?? "")
        : toolset,
    exclude,
  });
}

type ScopeModelCarrier = Partial<
  Pick<AgentState, "model" | "llm_config" | "model_settings">
>;

function providerTypeFromModelSettings(modelSettings: unknown): string | null {
  if (!isRecord(modelSettings)) return null;
  const providerType = modelSettings.provider_type;
  return typeof providerType === "string" ? providerType : null;
}

export type PreparedScopeToolContext = {
  preparedToolContext: PreparedToolExecutionContext;
  toolset: ToolsetName;
  toolsetPreference: ToolsetPreference;
  effectiveModel: string | null;
  agent: AgentState | null;
};

function mergeModAdapterCapabilities(
  adapters: ModAdapter[] | undefined,
  context: ModContext,
): {
  permissions?: Map<string, ModPermissionDefinition>;
  tools?: Map<string, ModToolDefinition>;
} {
  if (!adapters) return {};

  const permissions = new Map<string, ModPermissionDefinition>();
  const tools = new Map<string, ModToolDefinition>();
  for (const adapter of adapters) {
    for (const [id, permission] of adapter.getAvailablePermissions(context)) {
      permissions.set(id, permission);
    }
    for (const [name, tool] of adapter.getAvailableTools(context)) {
      tools.set(name, tool);
    }
  }
  return { permissions, tools };
}

function getPreferredAgentModelHandle(
  agent: ScopeModelCarrier | null | undefined,
): string | null {
  if (!agent) return null;
  if (typeof agent.model === "string" && agent.model.length > 0) {
    return agent.model;
  }
  return resolveModelHandleFromLlmConfig(agent.llm_config);
}

type ModelTarget = {
  model: string | null;
  providerType: string | null;
  openAICompatibleProxy: boolean;
};

function normalizeModelHandle(model: string | null | undefined): string | null {
  return model && model.length > 0 ? (resolveModel(model) ?? model) : null;
}

function modelTargetFromCarrier(
  carrier: ScopeModelCarrier | null | undefined,
): ModelTarget {
  const modelSettings = carrier?.model_settings;
  return {
    model: normalizeModelHandle(getPreferredAgentModelHandle(carrier)),
    providerType: providerTypeFromModelSettings(modelSettings),
    openAICompatibleProxy:
      isRecord(modelSettings) &&
      modelSettings[OPENAI_COMPATIBLE_PROXY_UPDATE_ARG] === true,
  };
}

function targetForMatchingModel(
  model: string,
  targets: ModelTarget[],
): ModelTarget | null {
  for (const target of targets) {
    if (target.model === model && target.providerType) {
      return target;
    }
  }
  return null;
}

export async function prepareToolExecutionContextForResolvedTarget(params: {
  modelIdentifier?: string | null;
  providerType?: string | null;
  openAICompatibleProxy?: boolean | null;
  conversationId?: string | null;
  toolsetPreference: ToolsetPreference;
  clientToolset?: ClientToolsetConfig;
  exclude?: ToolName[];
  clientToolAllowlist?: string[];
  externalToolScopeIds?: string[];
  workingDirectory?: string;
  permissionModeState?: PermissionModeState;
  modContext?: ModContext;
  modEvents?: ModEvents;
  modAdapters?: ModAdapter[];
  runtimeContext?: Partial<RuntimeContextSnapshot>;
  agent?: AgentState | null;
}): Promise<PreparedScopeToolContext> {
  const {
    modelIdentifier,
    providerType,
    openAICompatibleProxy,
    conversationId,
    toolsetPreference,
    clientToolset,
    exclude,
    clientToolAllowlist: inputToolAllowlist,
    externalToolScopeIds,
    workingDirectory,
    permissionModeState,
    modContext,
    modEvents,
    modAdapters,
    runtimeContext,
    agent,
  } = params;
  const launchTools = runtimeContext?.executionSettings?.tools;
  const clientToolAllowlist =
    launchTools === undefined
      ? inputToolAllowlist
      : inputToolAllowlist === undefined
        ? launchTools
        : launchTools.filter((name) =>
            inputToolAllowlist.some(
              (allowed) =>
                getInternalToolName(allowed) === getInternalToolName(name),
            ),
          );
  const effectiveModel =
    modelIdentifier && modelIdentifier.length > 0
      ? (resolveModel(modelIdentifier) ?? modelIdentifier)
      : null;
  const effectiveToolsetPreference = clientToolset?.base ?? toolsetPreference;
  const includedToolNames = resolveIncludedToolNames(clientToolset?.include);

  const resolvedToolset =
    effectiveToolsetPreference === "auto"
      ? deriveToolsetFromModel(effectiveModel ?? "", providerType, {
          openAICompatibleProxy,
        })
      : effectiveToolsetPreference;

  const scopedModContext = buildModInvocationContext({
    agent,
    base: modContext,
    conversationId,
    modelIdentifier: effectiveModel,
    permissionMode:
      permissionModeState?.mode ?? runtimeContext?.permissionMode ?? null,
    toolset: resolvedToolset,
    workingDirectory,
  });
  const modCapabilities = mergeModAdapterCapabilities(
    modAdapters,
    scopedModContext,
  );
  const preparedToolContext = await prepareToolExecutionContextForModel(
    effectiveModel ?? undefined,
    {
      resolvedToolset,
      exclude,
      include: includedToolNames,
      clientToolAllowlist,
      externalToolScopeIds,
      workingDirectory,
      permissionModeState,
      modContext: scopedModContext,
      modEvents,
      modPermissions: modCapabilities.permissions,
      modTools: modCapabilities.tools,
      runtimeContext,
    },
  );

  return {
    preparedToolContext,
    toolset: resolvedToolset,
    toolsetPreference,
    effectiveModel,
    agent: null,
  };
}

export async function prepareToolExecutionContextForScope(params: {
  connectionId?: string;
  environmentDeviceId?: string;
  agentId: string | null;
  conversationId?: string | null;
  overrideModel?: string | null;
  overrideProviderType?: string | null;
  cachedEffectiveModel?: string | null;
  exclude?: ToolName[];
  clientToolset?: ClientToolsetConfig;
  clientToolAllowlist?: string[];
  externalToolScopeIds?: string[];
  workingDirectory?: string;
  permissionModeState?: PermissionModeState;
  skillsDirectory?: string;
  skillSources?: SkillSource[];
  workspaceSandbox?: RuntimeContextSnapshot["workspaceSandbox"];
  executionSettings?: RuntimeContextSnapshot["executionSettings"];
  cachedAgent?: AgentState | null;
  modContext?: ModContext;
  modEvents?: ModEvents;
  modAdapters?: ModAdapter[];
}): Promise<PreparedScopeToolContext> {
  const {
    connectionId,
    environmentDeviceId,
    agentId,
    conversationId,
    overrideModel,
    overrideProviderType,
    cachedEffectiveModel,
    exclude,
    clientToolset: requestClientToolset,
    clientToolAllowlist,
    externalToolScopeIds,
    workingDirectory,
    permissionModeState,
    skillsDirectory,
    skillSources,
    workspaceSandbox,
    executionSettings,
    cachedAgent,
    modContext,
    modEvents,
    modAdapters,
  } = params;

  const clientToolset: ClientToolsetConfig | undefined =
    requestClientToolset ??
    getStoredClientPreferences(agentId, conversationId).toolset;
  const backend = getBackend();
  const agent = agentId
    ? ((cachedAgent ??
        (await backend.retrieveAgent(agentId))) as ScopeModelCarrier)
    : null;
  const agentTarget = modelTargetFromCarrier(agent);
  // One read of the conversation record: the model target needs it, and the
  // dream declaration gate below needs its provenance. On the local backend
  // this call creates an unknown conversation, which is already this path's
  // existing behaviour (see `Backend.retrieveConversation`).
  const conversationRecord =
    conversationId && conversationId !== "default"
      ? await backend.retrieveConversation(conversationId)
      : null;
  const conversationTarget = conversationRecord
    ? modelTargetFromCarrier(conversationRecord as ScopeModelCarrier)
    : { model: null, providerType: null, openAICompatibleProxy: false };
  /**
   * F-06: a dream run's hidden conversation is the only place the dream tool
   * family belongs. Passing the names as `include` loads them into the
   * execution registry *and* puts them in the declared payload together, so a
   * frozen `client_tools` can never advertise a tool this process cannot
   * resolve (the failure mode `declaration-gates.ts` warns about).
   */
  const dreamRun =
    conversationRecord !== null &&
    readConversationProvenance(conversationRecord).origin === "dream";

  const explicitModel = normalizeModelHandle(overrideModel);
  const cachedModel = normalizeModelHandle(cachedEffectiveModel);
  const effectiveModel =
    explicitModel ??
    cachedModel ??
    conversationTarget.model ??
    agentTarget.model;
  const matchedTarget = effectiveModel
    ? targetForMatchingModel(effectiveModel, [conversationTarget, agentTarget])
    : null;
  let effectiveProviderType = explicitModel
    ? (overrideProviderType ?? matchedTarget?.providerType ?? null)
    : cachedModel
      ? (matchedTarget?.providerType ?? null)
      : conversationTarget.model
        ? conversationTarget.providerType
        : agentTarget.providerType;
  const effectiveOpenAICompatibleProxy =
    matchedTarget?.openAICompatibleProxy ??
    (conversationTarget.model === effectiveModel
      ? conversationTarget.openAICompatibleProxy
      : agentTarget.openAICompatibleProxy);

  const toolsetPreference = (() => {
    try {
      return settingsManager.getToolsetPreference(
        agentId ?? conversationId ?? "agent-free",
        conversationId ?? "default",
      );
    } catch {
      return "auto" as const;
    }
  })();
  const effectiveToolsetPreference = clientToolset?.base ?? toolsetPreference;

  if (
    effectiveModel &&
    !effectiveProviderType &&
    effectiveToolsetPreference === "auto"
  ) {
    try {
      effectiveProviderType =
        (await getModelProviderType(effectiveModel)) ?? null;
    } catch {
      // Model metadata is best-effort. Handle-based classification remains
      // available when the provider inventory cannot be fetched.
    }
  }

  const scopedConversationId = conversationId ?? "default";

  // The dream family plus the ordinary tools the prompts require (R-5.4.3):
  // a model-derived preset may not carry file tools, and `include` rejects
  // unknown names, so every name is filtered against the definitions.
  const dreamToolIncludes = dreamRun
    ? [...DREAM_TOOL_NAMES, ...DREAM_REQUIRED_TOOL_NAMES].filter((name) =>
        Object.hasOwn(TOOL_DEFINITIONS, name),
      )
    : [];
  const effectiveClientToolset =
    dreamToolIncludes.length > 0
      ? {
          ...(clientToolset ?? {}),
          include: [...(clientToolset?.include ?? []), ...dreamToolIncludes],
        }
      : clientToolset;
  // A dream run has nobody to answer an interactive question (F-06 Q-53 / §2.5).
  const effectiveExclude = dreamRun
    ? [...(exclude ?? []), ...INTERACTIVE_USER_INPUT_TOOL_NAMES]
    : exclude;

  const result = await prepareToolExecutionContextForResolvedTarget({
    modelIdentifier: effectiveModel,
    providerType: effectiveProviderType,
    openAICompatibleProxy: effectiveOpenAICompatibleProxy,
    conversationId: conversationId ?? undefined,
    toolsetPreference,
    clientToolset: effectiveClientToolset,
    exclude: effectiveExclude,
    clientToolAllowlist,
    externalToolScopeIds,
    workingDirectory,
    permissionModeState,
    modContext,
    modEvents,
    modAdapters,
    agent: agent as AgentState | null,
    runtimeContext: {
      connectionId,
      environmentDeviceId,
      agentId,
      agentName: (agent as AgentState | null)?.name ?? null,
      conversationId: scopedConversationId,
      workingDirectory,
      ...(skillsDirectory !== undefined ? { skillsDirectory } : {}),
      ...(skillSources !== undefined ? { skillSources } : {}),
      ...(workspaceSandbox !== undefined ? { workspaceSandbox } : {}),
      executionSettings,
      ...(dreamRun ? { dreamRun } : {}),
      ...(dreamRun ? readDreamRunContext(process.env) : {}),
    },
  });
  return { ...result, agent: agent as AgentState | null };
}

type PersistedToolRule = NonNullable<AgentState["tool_rules"]>[number];

interface AgentWithToolsAndRules {
  tags?: string[] | null;
  tool_rules?: PersistedToolRule[];
}

export function shouldClearPersistedToolRules(
  agent: AgentWithToolsAndRules,
): boolean {
  return (
    agent.tags?.includes("origin:letta-code") === true &&
    (agent.tool_rules?.length ?? 0) > 0
  );
}

export async function clearPersistedClientToolRules(
  agentId: string,
  cachedAgent?: AgentState | null,
): Promise<{ removedToolNames: string[] } | null> {
  const backend = getBackend();

  try {
    const agentWithTools = (cachedAgent ??
      (await backend.retrieveAgent(agentId, {
        include: ["agent.tools"],
      }))) as AgentWithToolsAndRules;
    if (!shouldClearPersistedToolRules(agentWithTools)) {
      return null;
    }
    const existingRules = agentWithTools.tool_rules || [];

    await backend.updateAgent(agentId, {
      tool_rules: [],
    });

    return {
      removedToolNames: existingRules
        .map((rule) => rule.tool_name)
        .filter((name): name is string => typeof name === "string"),
    };
  } catch (err) {
    console.warn(
      `Warning: Failed to clear persisted client tool rules: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Force switch to a specific toolset regardless of model.
 *
 * @param toolsetName - The toolset to switch to
 */
export async function forceToolsetSwitch(
  toolsetName: ToolsetName,
): Promise<void> {
  await loadTools(undefined, { resolvedToolset: toolsetName });
}

/**
 * Switches the loaded toolset based on the target model identifier.
 *
 * @param modelIdentifier - The model handle/id
 * @param providerType - Provider type used to refine toolset derivation
 */
export async function switchToolsetForModel(
  modelIdentifier: string,
  providerType?: string | null,
): Promise<ToolsetName> {
  const toolset = deriveToolsetFromModel(modelIdentifier, providerType);
  await forceToolsetSwitch(toolset);
  return toolset;
}
