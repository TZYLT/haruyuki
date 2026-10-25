/**
 * Secret capture and write-back: the three partitions carried by `secrets.json`.
 *
 * Two invariants live here rather than in the pipelines:
 *   - No output ever contains a secret VALUE. Names and scopes only, even with
 *     `--verbose`. Failure reasons are fixed labels plus an error code, never a
 *     backend message, so a store that echoes a value cannot leak it.
 *   - Capture is read-only. `settingsManager.initialize()` (writes defaults and
 *     migrates tokens), `listChannelAccountsWithSecrets()` (hydrates and saves
 *     `accounts.json`) and `setSecureTokens()` are all forbidden on the export
 *     path; capture reads the files and the pure readers directly.
 *
 * Agent secrets are read through `refreshAndListSecrets()` and written through
 * `applySecretBatch()`, both of which resolve their local-backend root from
 * `LETTA_LOCAL_BACKEND_DIR` / the default under the home directory. A caller
 * that relocates `roots.storageDir` must relocate that root too.
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getChannelAccountsPath } from "@/channels/config";
import {
  type ActiveChannelCredentialsStoreMode,
  getActiveChannelCredentialsStoreMode,
  getChannelSecret,
  setChannelSecret,
} from "@/channels/credential-store";
import { getSupportedChannelIds } from "@/channels/plugin-registry";
import { APP_SUBDIRS, appHomeRoot } from "@/utils/app-paths";
import {
  getSecureTokens,
  isKeychainAvailable,
  type SecureTokens,
  setSecureTokens,
} from "@/utils/secrets";
import { applySecretBatch, refreshAndListSecrets } from "@/utils/secrets-store";
import type { ScopeRoots } from "./scope";
import {
  type SnapshotCliDeps,
  type SnapshotFailedSecret,
  snapshotError,
} from "./types";

/** Which store the channel account values came from when the bundle was taken. */
export type ChannelStoreMode = "file" | "keyring";

/** `secrets.json.settings` keys: the two names `src/utils/secrets.ts` owns. */
export const SECRET_SETTINGS_API_KEY = "letta-api-key";
export const SECRET_SETTINGS_REFRESH_TOKEN = "letta-refresh-token";

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

/** The keychain surface capture and write-back need; overridable in tests. */
export interface SnapshotSecretsIo {
  isKeychainAvailable(): Promise<boolean>;
  getSecureTokens(): Promise<SecureTokens>;
  setSecureTokens(tokens: SecureTokens): Promise<void>;
}

let secretsIoOverrideForTests: SnapshotSecretsIo | null = null;

/** Test-only: replace the keychain surface so tests never touch real secrets. */
export function __setSnapshotSecretsIoForTests(
  io: SnapshotSecretsIo | null,
): void {
  secretsIoOverrideForTests = io;
}

function secretsIo(): SnapshotSecretsIo {
  return (
    secretsIoOverrideForTests ?? {
      isKeychainAvailable,
      getSecureTokens,
      setSecureTokens,
    }
  );
}

/** The placeholder `accounts.json` carries in place of a keyring-held value. */
const CHANNEL_SECRET_PLACEHOLDER = "__haruyuki_channel_secret_present__";

/** Fields `src/channels/accounts.ts` keeps in the keyring, per channel shape. */
const KNOWN_CHANNEL_SECRET_FIELDS: Record<string, readonly string[]> = {
  slack: ["botToken", "appToken"],
  telegram: ["token"],
  discord: ["token"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * A failure reason that can never contain a secret value: a fixed label plus the
 * error's machine code. Backend messages are deliberately dropped.
 */
function failureReason(action: string, error: unknown): string {
  const code = errorCode(error);
  return code ? `${action} (${code})` : action;
}

function settingsPathFor(appHome: string): string {
  return join(appHome, APP_SUBDIRS.settingsFile);
}

function readSettingsObject(
  settingsPath: string,
): Record<string, unknown> | null {
  if (!existsSync(settingsPath)) return null;

  let raw: string;
  try {
    raw = readFileSync(settingsPath, "utf-8");
  } catch {
    throw snapshotError("io_error", `Cannot read ${settingsPath}.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw snapshotError(
      "io_error",
      `settings.json is not valid JSON: ${settingsPath}`,
    );
  }
  if (!isRecord(parsed)) {
    throw snapshotError(
      "io_error",
      `settings.json is not a JSON object: ${settingsPath}`,
    );
  }
  return parsed;
}

/** tmp + fsync + rename; settings may carry plaintext tokens, so mode 0600. */
function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporaryPath, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporaryPath, path);
  } finally {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Usually already renamed. Cleanup must not mask a failed write/rename.
    }
  }
}

// ── capture ─────────────────────────────────────────────────────────

function collectSettingsFromFile(appHome: string): Record<string, string> {
  const settings: Record<string, string> = {};
  const parsed = readSettingsObject(settingsPathFor(appHome));
  if (!parsed) return settings;

  const refreshToken = parsed.refreshToken;
  if (typeof refreshToken === "string" && refreshToken) {
    settings[SECRET_SETTINGS_REFRESH_TOKEN] = refreshToken;
  }
  const env = parsed.env;
  if (isRecord(env)) {
    const apiKey = env.LETTA_API_KEY;
    if (typeof apiKey === "string" && apiKey) {
      settings[SECRET_SETTINGS_API_KEY] = apiKey;
    }
  }
  return settings;
}

async function collectAgentSecrets(
  agentIds: ReadonlyArray<string>,
): Promise<Record<string, Record<string, string>>> {
  const agents: Record<string, Record<string, string>> = {};
  const uniqueIds = [
    ...new Set(agentIds.map((id) => id.trim()).filter((id) => id.length > 0)),
  ].sort();

  for (const agentId of uniqueIds) {
    let entries: Array<{ key: string; value: string }>;
    try {
      entries = await refreshAndListSecrets(agentId);
    } catch (error) {
      // The package must be complete: a secret store we cannot read is an
      // export failure, reported by name only.
      throw snapshotError(
        "io_error",
        `Cannot read secrets for agent ${agentId} (${errorCode(error) ?? "read failed"}).`,
      );
    }

    const values: Record<string, string> = {};
    for (const entry of entries) {
      if (entry.value) values[entry.key] = entry.value;
    }
    if (Object.keys(values).length > 0) agents[agentId] = values;
  }

  return agents;
}

function secretFieldPathsFor(channelId: string): readonly string[] {
  return (
    KNOWN_CHANNEL_SECRET_FIELDS[channelId] ?? [
      "config.bot_token",
      "config.auth",
    ]
  );
}

function readAccountField(
  account: Record<string, unknown>,
  path: string,
): unknown {
  if (!path.startsWith("config.")) return account[path];
  const config = account.config;
  if (!isRecord(config)) return undefined;
  return config[path.slice("config.".length)];
}

/** Placeholder fields are references into the keyring; find them generically. */
function placeholderFieldPaths(account: Record<string, unknown>): string[] {
  const paths: string[] = [];
  for (const [key, value] of Object.entries(account)) {
    if (key === "__haruyuki_secret_refs") continue;
    if (value === CHANNEL_SECRET_PLACEHOLDER) paths.push(key);
  }
  if (isRecord(account.config)) {
    for (const [key, value] of Object.entries(account.config)) {
      if (value === CHANNEL_SECRET_PLACEHOLDER) paths.push(`config.${key}`);
    }
  }
  return paths;
}

async function collectAccountSecrets(
  channelId: string,
  accountId: string,
  account: Record<string, unknown>,
): Promise<Record<string, string>> {
  const fields: Record<string, string> = {};
  const paths = new Set([
    ...secretFieldPathsFor(channelId),
    ...placeholderFieldPaths(account),
  ]);

  for (const path of paths) {
    const value = readAccountField(account, path);
    if (
      typeof value === "string" &&
      value.length > 0 &&
      value !== CHANNEL_SECRET_PLACEHOLDER
    ) {
      fields[path] = value;
      continue;
    }

    // A placeholder (or an empty field that a secret ref covers) means the value
    // lives in the keyring. `getChannelSecret` is a read-only store call.
    try {
      const stored = await getChannelSecret(channelId, accountId, path);
      if (stored) fields[path] = stored;
    } catch {
      // Unreadable keyring entry: the field is simply not carried.
    }
  }

  return fields;
}

interface ChannelAccountFile {
  channelId: string;
  accounts: Record<string, unknown>[];
}

function loadChannelAccountFiles(): ChannelAccountFile[] {
  let channelIds: string[];
  try {
    channelIds = getSupportedChannelIds();
  } catch {
    return [];
  }

  const files: ChannelAccountFile[] = [];
  for (const channelId of channelIds) {
    const accountsPath = getChannelAccountsPath(channelId);
    if (!existsSync(accountsPath)) continue;

    let raw: string;
    try {
      raw = readFileSync(accountsPath, "utf-8");
    } catch {
      throw snapshotError("io_error", `Cannot read ${accountsPath}.`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw snapshotError(
        "io_error",
        `Channel accounts file is not valid JSON: ${accountsPath}`,
      );
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.accounts)) continue;

    files.push({
      channelId,
      accounts: parsed.accounts.filter(isRecord),
    });
  }
  return files;
}

interface CollectedChannels {
  channels: Record<string, Record<string, Record<string, string>>>;
  storeMode: ChannelStoreMode;
}

async function collectChannelSecrets(): Promise<CollectedChannels> {
  const files = loadChannelAccountFiles();
  const channels: CollectedChannels["channels"] = {};
  if (files.length === 0) return { channels, storeMode: "file" };

  let storeMode: ChannelStoreMode;
  try {
    storeMode = await getActiveChannelCredentialsStoreMode();
  } catch {
    throw snapshotError(
      "io_error",
      "Channel credential store is set to keyring, but OS secure storage is unavailable.",
    );
  }

  for (const file of files) {
    for (const account of file.accounts) {
      const accountId = account.accountId;
      if (typeof accountId !== "string" || accountId.length === 0) continue;

      const fields = await collectAccountSecrets(
        file.channelId,
        accountId,
        account,
      );
      if (Object.keys(fields).length === 0) continue;

      const channelBucket = channels[file.channelId] ?? {};
      channelBucket[accountId] = fields;
      channels[file.channelId] = channelBucket;
    }
  }

  return { channels, storeMode };
}

/**
 * Read all three partitions. `agentIds` must be supplied by the caller: the
 * agent list cannot be recovered from the secrets store itself.
 */
export async function collectSecrets(
  roots: ScopeRoots,
  agentIds: ReadonlyArray<string>,
): Promise<SecretBundle> {
  const io = secretsIo();

  let keychainAvailable = false;
  try {
    keychainAvailable = await io.isKeychainAvailable();
  } catch {
    keychainAvailable = false;
  }

  const settings: Record<string, string> = {};
  if (keychainAvailable) {
    let tokens: SecureTokens;
    try {
      tokens = await io.getSecureTokens();
    } catch {
      throw snapshotError(
        "io_error",
        "Cannot read the settings tokens from OS secure storage.",
      );
    }
    if (tokens.apiKey) settings[SECRET_SETTINGS_API_KEY] = tokens.apiKey;
    if (tokens.refreshToken) {
      settings[SECRET_SETTINGS_REFRESH_TOKEN] = tokens.refreshToken;
    }
  } else {
    Object.assign(settings, collectSettingsFromFile(roots.appHome));
  }

  const agents = await collectAgentSecrets(agentIds);
  const { channels, storeMode } = await collectChannelSecrets();

  return {
    version: 1,
    settings,
    agents,
    channels,
    meta: {
      channelStoreMode: storeMode,
      capturedAt: new Date().toISOString(),
    },
  };
}

// ── package sanitization ────────────────────────────────────────────

/**
 * Return a COPY of a settings object with the plaintext token fallbacks removed.
 *
 * The package copy must not carry `env.LETTA_API_KEY` / top-level
 * `refreshToken`; their values live in `secrets.json.settings` instead. The
 * source file is never touched — the caller passes the parsed copy it read.
 */
export function sanitizeSettingsForPackage(
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...settings };
  delete copy.refreshToken;

  if (isRecord(copy.env)) {
    const { LETTA_API_KEY: _omit, ...otherEnv } = copy.env;
    if (Object.keys(otherEnv).length > 0) {
      copy.env = otherEnv;
    } else {
      delete copy.env;
    }
  }

  return copy;
}

// ── write-back ──────────────────────────────────────────────────────

function writeSettingsTokensToFile(
  settingsPath: string,
  tokens: SecureTokens,
): void {
  const existing = readSettingsObject(settingsPath) ?? {};
  const next: Record<string, unknown> = { ...existing };

  if (tokens.apiKey) {
    const env = isRecord(next.env) ? next.env : {};
    next.env = { ...env, LETTA_API_KEY: tokens.apiKey };
  }
  if (tokens.refreshToken) {
    next.refreshToken = tokens.refreshToken;
  }

  writeJsonAtomic(settingsPath, next);
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
  const io = secretsIo();
  const result: ApplySecretsResult = { written: 0, failed: [] };

  let keychainAvailable = false;
  try {
    keychainAvailable = await io.isKeychainAvailable();
  } catch {
    keychainAvailable = false;
  }

  // settings: hold each token separately so one failure does not lose the other.
  const settingsTokens: Array<{ name: string; tokens: SecureTokens }> = [];
  const apiKey = bundle.settings?.[SECRET_SETTINGS_API_KEY];
  const refreshToken = bundle.settings?.[SECRET_SETTINGS_REFRESH_TOKEN];
  if (apiKey) {
    settingsTokens.push({
      name: SECRET_SETTINGS_API_KEY,
      tokens: { apiKey },
    });
  }
  if (refreshToken) {
    settingsTokens.push({
      name: SECRET_SETTINGS_REFRESH_TOKEN,
      tokens: { refreshToken },
    });
  }

  if (keychainAvailable) {
    for (const item of settingsTokens) {
      try {
        await io.setSecureTokens(item.tokens);
        result.written += 1;
      } catch (error) {
        result.failed.push({
          scope: "settings",
          name: item.name,
          reason: failureReason("keychain write failed", error),
        });
      }
    }
  } else if (settingsTokens.length > 0) {
    try {
      writeSettingsTokensToFile(
        settingsPathFor(deps?.homeRoot ?? appHomeRoot()),
        { apiKey, refreshToken },
      );
      result.written += settingsTokens.length;
    } catch (error) {
      for (const item of settingsTokens) {
        result.failed.push({
          scope: "settings",
          name: item.name,
          reason: failureReason("settings.json write failed", error),
        });
      }
    }
  }

  // agents: one batch per agent; a failed batch reports every name it carried.
  const agentEntries = Object.entries(bundle.agents ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  for (const [agentId, values] of agentEntries) {
    const names = Object.keys(values);
    if (names.length === 0) continue;

    try {
      await applySecretBatch({ set: values }, agentId);
      result.written += names.length;
    } catch (error) {
      for (const name of names) {
        result.failed.push({
          scope: "agent",
          name: `${agentId}/${name}`,
          reason: failureReason("agent secret write failed", error),
        });
      }
    }
  }

  // channels: only a keyring target can receive them. In file mode the values
  // travel inside accounts.json; a keyring-sourced bundle landing on a file-mode
  // target cannot be written, so it is reported for re-authorization.
  const channelEntries = Object.entries(bundle.channels ?? {});
  if (channelEntries.length > 0) {
    const sourceMode = bundle.meta?.channelStoreMode ?? "file";
    let targetMode: ActiveChannelCredentialsStoreMode = "file";
    try {
      targetMode = await getActiveChannelCredentialsStoreMode();
    } catch {
      targetMode = "file";
    }

    for (const [channelId, accounts] of channelEntries) {
      for (const [accountId, fields] of Object.entries(accounts)) {
        for (const [field, value] of Object.entries(fields)) {
          const name = `${channelId}/${accountId}/${field}`;
          if (targetMode !== "keyring") {
            if (sourceMode === "keyring") {
              result.failed.push({
                scope: "channel",
                name,
                reason:
                  "channel credential store is file-backed; value not written, re-authorize the channel",
              });
            }
            continue;
          }

          try {
            await setChannelSecret(channelId, accountId, field, value);
            result.written += 1;
          } catch (error) {
            result.failed.push({
              scope: "channel",
              name,
              reason: failureReason("channel credential write failed", error),
            });
          }
        }
      }
    }
  }

  return result;
}
