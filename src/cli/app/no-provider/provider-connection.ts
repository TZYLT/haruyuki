/**
 * The `--no-provider` empty state's connection half (T-07, R-07.3–R-07.5, Q-44).
 *
 * The surface reuses `ProviderSelector` for the API-key path, which means the
 * success signal is not a callback from that component — it is the provider
 * appearing in the store. This module is the poll-and-continue side: it reads
 * the store, refreshes the model catalog, creates the default agent, and turns
 * the outcome into either an agent id (enter the session) or one plain sentence
 * the empty state can paint. Keeping it out of the component makes the wording
 * and the failure branches testable without a TTY.
 */

import { ensureDefaultAgents } from "@/agent/defaults";
import { refreshModelCatalog } from "@/agent/remote-model-catalog";
import { getBackend } from "@/backend";
import { getConnectedProviders } from "@/providers/byok-providers";

export type NoProviderConnectResult =
  | { kind: "connected"; agentId: string }
  | { kind: "error"; message: string };

/** Names of the providers currently in the provider store. */
export async function listConnectedProviderNames(): Promise<string[]> {
  const providers = await getConnectedProviders();
  return Array.from(providers.keys());
}

/** R-07.5: a message sent in the empty state gets a line, not silence. */
export function formatDisconnectedMessageHint(): string {
  return [
    "Not connected yet: connect a provider before sending messages.",
    "In the TUI run /config connect; in a shell run haruyuki connect <provider>.",
  ].join(" ");
}

/** R-07.3: OAuth providers are connected from a shell, not from this surface. */
export function formatOAuthShellGuidance(providerLabel: string): string {
  return [
    `${providerLabel} sign-in runs in a shell, not in this empty state.`,
    "Open another terminal and run haruyuki connect <provider>, then come back here.",
  ].join(" ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Q-44: the provider connected, so finish the start the user originally asked
 * for — default agent, then session. A failure stays in the empty state with the
 * reason (47-2 §2.5), never a silent exit.
 */
export async function createDefaultAgentAfterConnect(): Promise<NoProviderConnectResult> {
  // The catalog was empty when the TUI started; refresh it from the newly
  // connected provider before anything resolves a default model.
  await refreshModelCatalog({ force: true });

  try {
    const agent = await ensureDefaultAgents(getBackend(), {
      personality: "memo",
    });
    if (!agent) {
      return {
        kind: "error",
        message:
          "Provider connected, but no default agent was created (default-agent creation is disabled). Re-enable it in settings, or restart Haruyuki.",
      };
    }
    return { kind: "connected", agentId: agent.id };
  } catch (error) {
    return {
      kind: "error",
      message: `Provider connected, but creating the default agent failed: ${errorMessage(error)}`,
    };
  }
}
