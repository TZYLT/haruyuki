/**
 * Default agent (Haruyuki) creation and management.
 *
 * Haruyuki: Stateful agent with full memory - learns and grows with the user.
 */

import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { ONBOARDING_ORIGIN_TAG } from "@/agent/agent-tags";
import type { Backend } from "@/backend";
import { isCloudServerUrl } from "@/backend/api/server-url";
import { settingsManager } from "@/settings-manager";
import { type CreateAgentOptions, createAgent } from "./create";
import { getDefaultModel, models, resolveModel } from "./model";
import { buildCreateAgentOptionsForPersonality } from "./personality";

// Tags used to identify default agents
export const MEMO_TAG = "default:memo";
export const TUTOR_TAG = "default:tutorial";

/**
 * Personalities the startup bootstrap can create. Both a true fresh start
 * (brand-new account, nothing to resume) and an explicit `--new-agent` get the
 * companion memo agent; tutorial stays selectable from the preset table.
 */
export type DefaultAgentPersonality = "memo" | "tutorial";

// Identity of the default agent, shown in /agent list. The persona/human bodies come
// from the personality preset table, so there is no second copy to drift.
const MEMO_NAME = "Haruyuki";
const MEMO_DESCRIPTION = "The default Haruyuki agent with persistent memory";

function isSelfHostedServer(): boolean {
  // One Cloud judgement for the whole repo lives in `server-url.ts`; it compares
  // hostnames, so lookalikes such as `notapi.letta.com` no longer count.
  return !isCloudServerUrl();
}

export function selectDefaultAgentModel(params: {
  preferredModel?: string;
  isSelfHosted: boolean;
  availableHandles?: Iterable<string>;
}): string | undefined {
  const { preferredModel, isSelfHosted, availableHandles } = params;
  const resolvedPreferred =
    typeof preferredModel === "string" && preferredModel.length > 0
      ? (resolveModel(preferredModel) ?? preferredModel)
      : undefined;

  if (!isSelfHosted) {
    return resolvedPreferred;
  }

  const handles = availableHandles ? new Set(availableHandles) : null;
  if (!handles) {
    return resolvedPreferred;
  }

  // An empty availability list is not a veto. A bare local store, or a dev
  // executor with no provider configured, reports no models; dropping the
  // caller's explicit choice there leaves agent creation with no model at all,
  // which then fails on the catalog lookup instead of using what was asked for.
  if (handles.size === 0) {
    return resolvedPreferred;
  }

  if (resolvedPreferred && handles.has(resolvedPreferred)) {
    return resolvedPreferred;
  }

  const firstHandle = Array.from(handles)[0];

  // An empty catalog has no default to prefer, and the caller's availability
  // list is authoritative, so fall back to whatever it listed first.
  if (models.length > 0) {
    const defaultHandle = getDefaultModel();
    if (handles.has(defaultHandle)) {
      return defaultHandle;
    }
  }

  return firstHandle;
}

async function resolveDefaultAgentModel(
  backend: Backend,
  preferredModel?: string,
): Promise<string | undefined> {
  if (!isSelfHostedServer()) {
    return selectDefaultAgentModel({
      preferredModel,
      isSelfHosted: false,
    });
  }

  try {
    const availableHandles = new Set(
      (await backend.listModels())
        .map((model) => model.handle)
        .filter((handle): handle is string => typeof handle === "string"),
    );

    return selectDefaultAgentModel({
      preferredModel,
      isSelfHosted: true,
      availableHandles,
    });
  } catch {
    return selectDefaultAgentModel({
      preferredModel,
      isSelfHosted: true,
    });
  }
}

/**
 * Add a tag to an existing agent.
 */
async function addTagToAgent(
  backend: Backend,
  agentId: string,
  newTag: string,
): Promise<void> {
  try {
    const agent = await backend.retrieveAgent(agentId, {
      include: ["agent.tags"],
    });
    const currentTags = agent.tags || [];
    if (!currentTags.includes(newTag)) {
      await backend.updateAgent(agentId, {
        tags: [...currentTags, newTag],
      });
    }
  } catch (err) {
    console.warn(
      `Warning: Failed to add tag to agent: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Create a fresh default Haruyuki agent and pin it globally.
 * Always creates a new agent — does NOT search by tag to avoid picking up
 * agents created by other users on shared Letta Cloud orgs.
 *
 * Respects `createDefaultAgents` setting (defaults to true).
 *
 * @returns The Haruyuki agent (or null if creation disabled/failed).
 */
export async function ensureDefaultAgents(
  backend: Backend,
  options?: {
    preferredModel?: string;
    /** Which personality the created agent gets. Defaults to memo (Haruyuki). */
    personality?: DefaultAgentPersonality;
  },
): Promise<AgentState | null> {
  if (!settingsManager.shouldCreateDefaultAgents()) {
    return null;
  }

  const personality = options?.personality ?? "memo";

  try {
    // Pre-determine memfs mode so the agent is created with the correct prompt.
    // Auto-enabling memory on a Cloud agent needed `remoteMemfs && isLettaCloud()`;
    // the removed API backend was the only backend that could satisfy it, so the
    // only mode left to choose is the local one.
    const memoryPromptMode = backend.capabilities.localMemfs
      ? "local-memfs"
      : undefined;

    const model = await resolveDefaultAgentModel(
      backend,
      options?.preferredModel,
    );

    const environment = backend.capabilities.localMemfs ? "local" : "cloud";
    // Both default personalities go through the preset builder: memo now ships
    // the guided first-contact block too (41 §2.3), so the two creation paths
    // must not fork again.
    const createOptions: CreateAgentOptions =
      personality === "tutorial"
        ? {
            ...(await buildCreateAgentOptionsForPersonality({
              personalityId: "tutorial",
              model,
              tags: [ONBOARDING_ORIGIN_TAG],
              environment,
            })),
            memoryPromptMode,
          }
        : {
            ...(await buildCreateAgentOptionsForPersonality({
              personalityId: "memo",
              name: MEMO_NAME,
              description: MEMO_DESCRIPTION,
              model,
              environment,
            })),
            memoryPromptMode,
          };

    const { agent } = await createAgent(createOptions);
    await addTagToAgent(
      backend,
      agent.id,
      personality === "tutorial" ? TUTOR_TAG : MEMO_TAG,
    );
    settingsManager.pinAgent(agent.id);

    return agent;
  } catch (err) {
    // Re-throw so the caller can label the step and exit. Both callers already
    // name it (`Failed to create default agent` in the TUI, `Error:` in
    // headless), so wrapping here only stacked a second prefix on the user.
    throw err instanceof Error ? err : new Error(String(err));
  }
}
