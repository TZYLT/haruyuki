/**
 * Secret capture and write-back: the three partitions carried by `secrets.json`.
 *
 * M0 holds the shape only; M3 fills the bodies. Two invariants live here rather
 * than in the pipelines:
 *   - No output ever contains a secret VALUE. Names and scopes only, even with
 *     `--verbose`. Error messages included.
 *   - Capture is read-only. `settingsManager.initialize()` (writes defaults and
 *     migrates tokens), `listChannelAccountsWithSecrets()` and
 *     `setSecureTokens()` are all forbidden on the export path; export reads the
 *     files and the pure readers directly.
 */

import type { ScopeRoots } from "./scope";
import type { SnapshotCliDeps, SnapshotFailedSecret } from "./types";

/** Which store the channel account values came from when the bundle was taken. */
export type ChannelStoreMode = "file" | "keyring";

/**
 * `secrets.json` inside the package.
 *
 * `settings` holds the `letta-api-key` / `letta-refresh-token` pair;
 * `agents` is agentId -> NAME -> value; `channels` is
 * channelId -> accountId -> field -> value.
 */
export interface SecretBundle {
  version: 1;
  settings: Record<string, string>;
  agents: Record<string, Record<string, string>>;
  channels: Record<string, Record<string, Record<string, string>>>;
  meta: {
    channelStoreMode: ChannelStoreMode;
    capturedAt: string;
  };
}

export interface ApplySecretsResult {
  written: number;
  failed: SnapshotFailedSecret[];
}

/**
 * Read all three partitions. `agentIds` must be supplied by the caller: the
 * agent list cannot be recovered from the secrets store itself.
 */
export async function collectSecrets(
  roots: ScopeRoots,
  agentIds: ReadonlyArray<string>,
): Promise<SecretBundle> {
  void roots;
  void agentIds;
  throw new Error("snapshot/secrets.collectSecrets: implemented at M3");
}

/**
 * Write a bundle back on the target machine.
 *
 * Per-item failures are reported, never fatal: a missing keyring or one
 * unreadable agent entry must not abort an otherwise complete import. Keychain
 * availability decides between keychain and plain-file storage, matching what
 * `persistSettingsAndTokens` would do.
 */
export async function applySecrets(
  bundle: SecretBundle,
  deps?: SnapshotCliDeps,
): Promise<ApplySecretsResult> {
  void bundle;
  void deps;
  throw new Error("snapshot/secrets.applySecrets: implemented at M3");
}
