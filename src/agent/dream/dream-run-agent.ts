/**
 * Agent-level helpers for the dream run wiring (F-06 M2).
 *
 * Kept tiny and separate so the run controller and the wiring do not both reach
 * into the backend for the same display name.
 */

import { getBackend } from "@/backend";

/** The agent's display name, or `null` when the backend cannot answer. */
export async function getAgentDisplayName(
  agentId: string,
): Promise<string | null> {
  try {
    const agent = await getBackend().retrieveAgent(agentId);
    const name = (agent as unknown as { name?: unknown }).name;
    return typeof name === "string" && name.trim().length > 0
      ? name.trim()
      : null;
  } catch {
    return null;
  }
}
