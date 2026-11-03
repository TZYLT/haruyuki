// src/cli/app/pages/settings/embedding-secrets.ts

import {
  clearEmbeddingEndpointApiKey,
  type EmbeddingSecretStorage,
  getEmbeddingEndpointApiKey,
  getEmbeddingSecretStorageDisclosure,
  saveEmbeddingEndpointApiKey,
} from "@/backend/local/embedding/secrets";

/**
 * The settings page's endpoint-key row (48-2 O-18, R-36; D3 item 5).
 *
 * The row is a `secret` kind: the editor masks what is typed
 * (`settings-page.tsx`), the value is written through C1's
 * `saveEmbeddingEndpointApiKey`, and nothing this module returns ever contains
 * the key itself. The row's displayed value is a **presence word**, not the
 * credential.
 *
 * Presence is cached because `SettingsItem.read` is synchronous while the
 * secrets store is async. The cache starts at `unknown` and is filled by
 * {@link refreshEmbeddingApiKeyPresence} (the wizard and the status surface call
 * it) or by a save/clear here; the row therefore says "hidden (write-only)"
 * until something has looked. It never says "not set" on a guess.
 */

/** Whether an endpoint key is known to be stored. */
export type EmbeddingApiKeyPresence = "set" | "unset" | "unknown";

let cachedPresence: EmbeddingApiKeyPresence = "unknown";
let cachedStorage: EmbeddingSecretStorage | null = null;

const ROW_VALUES: Record<EmbeddingApiKeyPresence, string> = {
  set: "set (write-only)",
  unset: "not set",
  unknown: "hidden (write-only)",
};

/** The row's value: a presence word, never the credential. */
export function embeddingApiKeyRowValue(): string {
  return ROW_VALUES[cachedPresence];
}

/** The cached presence, for callers that must not await. */
export function getEmbeddingApiKeyPresence(): EmbeddingApiKeyPresence {
  return cachedPresence;
}

/** Which storage accepted the last save; `null` until one happened. */
export function getEmbeddingApiKeyStorage(): EmbeddingSecretStorage | null {
  return cachedStorage;
}

/**
 * Look up whether a key is stored, without returning it.
 *
 * Read failures are `unknown`, not `unset`: a locked keychain must not make the
 * row claim the key is missing.
 */
export async function refreshEmbeddingApiKeyPresence(
  agentId?: string,
): Promise<EmbeddingApiKeyPresence> {
  try {
    const key = await getEmbeddingEndpointApiKey(agentId);
    cachedPresence = key === null ? "unset" : "set";
  } catch {
    cachedPresence = "unknown";
  }
  return cachedPresence;
}

/** The honest R-36 disclosure (where the key lives) without its value. */
export async function describeEmbeddingApiKeyStorage(): Promise<string> {
  const disclosure = await getEmbeddingSecretStorageDisclosure();
  return disclosure.disclosure;
}

/** What a successful save reports: where it landed, never what it was. */
export interface EmbeddingApiKeySaveResult {
  readonly storage: EmbeddingSecretStorage;
  readonly disclosure: string;
}

/**
 * Persist the endpoint API key (write-only). An empty value is refused: clearing
 * is {@link clearEmbeddingApiKey}, which is a separate action with its own row.
 */
export async function saveEmbeddingApiKey(
  value: string,
  agentId?: string,
): Promise<EmbeddingApiKeySaveResult> {
  const storage = await saveEmbeddingEndpointApiKey(value, agentId);
  cachedPresence = "set";
  cachedStorage = storage;
  return { storage, disclosure: await describeEmbeddingApiKeyStorage() };
}

/** Remove the stored endpoint API key; returns whether anything was removed. */
export async function clearEmbeddingApiKey(agentId?: string): Promise<boolean> {
  const removed = await clearEmbeddingEndpointApiKey(agentId);
  cachedPresence = "unset";
  cachedStorage = null;
  return removed;
}

/**
 * Test-only: forget the cached presence.
 *
 * Exported with the repo's `__test` convention so a test order cannot decide
 * what a later file sees. Production code never calls it.
 */
export function __testResetEmbeddingApiKeyPresence(): void {
  cachedPresence = "unknown";
  cachedStorage = null;
}
