import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { __testOverrideChannelsRoot } from "@/channels/config";
import {
  __resetChannelCredentialsStoreModeCacheForTests,
  __setActiveChannelCredentialsStoreModeForTests,
  __setChannelCredentialsStoreModeForTests,
  __setChannelKeychainAvailableForTests,
  __setChannelSecretStoreOverrideForTests,
} from "@/channels/credential-store";
import { TestDirectory } from "@/test-utils/test-fs";
import {
  __testOverrideLocalSecretStorage,
  clearSecretsCache,
} from "@/utils/secrets-store";
import type { ScopeRoots } from "./scope";
import {
  __setSnapshotSecretsIoForTests,
  applySecrets,
  collectSecrets,
  SECRET_SETTINGS_API_KEY,
  SECRET_SETTINGS_REFRESH_TOKEN,
  type SecretBundle,
  type SnapshotSecretsIo,
  sanitizeSettingsForPackage,
} from "./secrets";
import { SnapshotError } from "./types";

let dir: TestDirectory;

beforeEach(() => {
  dir = new TestDirectory();
});

afterEach(() => {
  __setSnapshotSecretsIoForTests(null);
  __testOverrideLocalSecretStorage(null);
  clearSecretsCache(null);
  __setChannelSecretStoreOverrideForTests(null);
  __setActiveChannelCredentialsStoreModeForTests(null);
  __setChannelCredentialsStoreModeForTests(null);
  __setChannelKeychainAvailableForTests(null);
  __resetChannelCredentialsStoreModeCacheForTests();
  __testOverrideChannelsRoot(null);
  dir.cleanup();
});

function rootsFor(appHome: string, storageDir: string): ScopeRoots {
  return { appHome, storageDir, homedirRoot: join(storageDir, "..") };
}

function fileIo(overrides: Partial<SnapshotSecretsIo> = {}): SnapshotSecretsIo {
  return {
    isKeychainAvailable: async () => false,
    getSecureTokens: async () => {
      throw new Error("getSecureTokens must not run on the file fallback path");
    },
    setSecureTokens: async () => {
      throw new Error("setSecureTokens must not run on the file fallback path");
    },
    ...overrides,
  };
}

function memorySecretStorage(seed: Record<string, string>): {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<boolean>;
} {
  const values = new Map(Object.entries(seed));
  return {
    get: async (name) => values.get(name) ?? null,
    set: async (name, value) => {
      values.set(name, value);
    },
    delete: async (name) => values.delete(name),
  };
}

function seedAgentSecrets(agentId: string, secrets: Record<string, string>) {
  const seed: Record<string, string> = {
    [`agent:${agentId}:secrets:index`]: JSON.stringify(
      Object.keys(secrets).sort(),
    ),
  };
  for (const [name, value] of Object.entries(secrets)) {
    seed[`agent:${agentId}:secrets:${name}`] = value;
  }
  return seed;
}

function writeChannelAccounts(
  channelsRoot: string,
  channelId: string,
  accounts: unknown[],
): string {
  const channelDir = join(channelsRoot, channelId);
  mkdirSync(channelDir, { recursive: true });
  const path = join(channelDir, "accounts.json");
  writeFileSync(path, JSON.stringify({ accounts }, null, 2), "utf-8");
  return path;
}

function bundle(overrides: Partial<SecretBundle> = {}): SecretBundle {
  return {
    version: 1,
    settings: {},
    agents: {},
    channels: {},
    meta: { channelStoreMode: "file", capturedAt: "2026-10-25T00:00:00.000Z" },
    ...overrides,
  };
}

test("collects the three partitions and leaves every source file untouched", async () => {
  const appHome = dir.resolve("apphome");
  mkdirSync(appHome, { recursive: true });
  const settingsPath = join(appHome, "settings.json");
  writeFileSync(
    settingsPath,
    JSON.stringify({
      tokenStreaming: true,
      refreshToken: "refresh-from-file",
      env: { LETTA_API_KEY: "api-key-from-file", OTHER: "keep-me" },
    }),
    "utf-8",
  );
  const settingsBefore = readFileSync(settingsPath, "utf-8");

  const channelsRoot = dir.resolve("channels");
  const accountsPath = writeChannelAccounts(channelsRoot, "slack", [
    {
      channel: "slack",
      accountId: "account-1",
      botToken: "xoxb-plaintext",
      appToken: "__haruyuki_channel_secret_present__",
    },
  ]);
  const accountsBefore = readFileSync(accountsPath, "utf-8");

  __setSnapshotSecretsIoForTests(fileIo());
  __testOverrideChannelsRoot(channelsRoot);
  __setActiveChannelCredentialsStoreModeForTests("keyring");
  __setChannelSecretStoreOverrideForTests({
    get: async (name) =>
      name === "channel:slack:account-1:appToken" ? "xapp-from-keyring" : null,
    set: async () => {},
    delete: async () => false,
  });
  __testOverrideLocalSecretStorage(
    memorySecretStorage(
      seedAgentSecrets("agent-1", { OPENAI_KEY: "sk-agent" }),
    ),
  );

  const collected = await collectSecrets(
    rootsFor(appHome, dir.resolve("storage")),
    ["agent-2", "agent-1", "agent-1"],
  );

  expect(collected.version).toBe(1);
  expect(collected.settings).toEqual({
    [SECRET_SETTINGS_REFRESH_TOKEN]: "refresh-from-file",
    [SECRET_SETTINGS_API_KEY]: "api-key-from-file",
  });
  expect(collected.agents).toEqual({ "agent-1": { OPENAI_KEY: "sk-agent" } });
  expect(collected.channels).toEqual({
    slack: {
      "account-1": {
        botToken: "xoxb-plaintext",
        appToken: "xapp-from-keyring",
      },
    },
  });
  expect(collected.meta.channelStoreMode).toBe("keyring");
  expect(Number.isNaN(Date.parse(collected.meta.capturedAt))).toBe(false);

  // Capture is read-only: no source byte changed.
  expect(readFileSync(settingsPath, "utf-8")).toBe(settingsBefore);
  expect(readFileSync(accountsPath, "utf-8")).toBe(accountsBefore);
});

test("reads the tokens from the keychain when it is available", async () => {
  const appHome = dir.resolve("apphome");
  mkdirSync(appHome, { recursive: true });
  const settingsPath = join(appHome, "settings.json");
  writeFileSync(
    settingsPath,
    JSON.stringify({
      refreshToken: "stale-file-refresh",
      env: { LETTA_API_KEY: "stale-file-key" },
    }),
    "utf-8",
  );
  const settingsBefore = readFileSync(settingsPath, "utf-8");

  let secureTokenReads = 0;
  __setSnapshotSecretsIoForTests({
    isKeychainAvailable: async () => true,
    getSecureTokens: async () => {
      secureTokenReads += 1;
      return { apiKey: "keychain-key", refreshToken: "keychain-refresh" };
    },
    setSecureTokens: async () => {},
  });

  const collected = await collectSecrets(
    rootsFor(appHome, dir.resolve("storage")),
    [],
  );

  expect(secureTokenReads).toBe(1);
  expect(collected.settings).toEqual({
    [SECRET_SETTINGS_API_KEY]: "keychain-key",
    [SECRET_SETTINGS_REFRESH_TOKEN]: "keychain-refresh",
  });
  expect(readFileSync(settingsPath, "utf-8")).toBe(settingsBefore);
});

test("channel values captured in file mode are recorded with file metadata", async () => {
  const channelsRoot = dir.resolve("channels");
  writeChannelAccounts(channelsRoot, "telegram", [
    { channel: "telegram", accountId: "tg-1", token: "tg-plaintext-token" },
  ]);

  __setSnapshotSecretsIoForTests(fileIo());
  __testOverrideChannelsRoot(channelsRoot);
  __setActiveChannelCredentialsStoreModeForTests("file");

  const collected = await collectSecrets(
    rootsFor(dir.resolve("apphome"), dir.resolve("storage")),
    [],
  );

  expect(collected.channels).toEqual({
    telegram: { "tg-1": { token: "tg-plaintext-token" } },
  });
  expect(collected.meta.channelStoreMode).toBe("file");
});

test("sanitizeSettingsForPackage strips the plaintext fallbacks from a copy", () => {
  const input: Record<string, unknown> = {
    tokenStreaming: true,
    refreshToken: "refresh-secret-value",
    env: { LETTA_API_KEY: "api-secret-value", LETTA_BASE_URL: "http://local" },
  };

  const sanitized = sanitizeSettingsForPackage(input);

  expect(sanitized).not.toBe(input);
  expect(sanitized.refreshToken).toBeUndefined();
  expect(sanitized.env).toEqual({ LETTA_BASE_URL: "http://local" });
  expect(sanitized.tokenStreaming).toBe(true);
  // The source object is not mutated (export is a read-only operation).
  expect(input.refreshToken).toBe("refresh-secret-value");
  expect((input.env as Record<string, string>).LETTA_API_KEY).toBe(
    "api-secret-value",
  );
  expect(JSON.stringify(sanitized)).not.toContain("secret-value");
});

test("sanitizeSettingsForPackage drops an env object left empty", () => {
  const sanitized = sanitizeSettingsForPackage({
    env: { LETTA_API_KEY: "only-token" },
  });

  expect(sanitized.env).toBeUndefined();
});

test("applySecrets writes settings tokens to the keychain when available", async () => {
  const writes: Array<Record<string, string | undefined>> = [];
  __setSnapshotSecretsIoForTests({
    isKeychainAvailable: async () => true,
    getSecureTokens: async () => ({}),
    setSecureTokens: async (tokens) => {
      writes.push({ apiKey: tokens.apiKey, refreshToken: tokens.refreshToken });
    },
  });

  const result = await applySecrets(
    bundle({
      settings: {
        [SECRET_SETTINGS_API_KEY]: "new-key",
        [SECRET_SETTINGS_REFRESH_TOKEN]: "new-refresh",
      },
    }),
    { homeRoot: dir.resolve("apphome") },
  );

  expect(result).toEqual({ written: 2, failed: [] });
  expect(writes).toEqual([
    { apiKey: "new-key", refreshToken: undefined },
    { apiKey: undefined, refreshToken: "new-refresh" },
  ]);
});

test("applySecrets falls back to settings.json tokens when the keychain is unavailable", async () => {
  const appHome = dir.resolve("apphome");
  mkdirSync(appHome, { recursive: true });
  const settingsPath = join(appHome, "settings.json");
  writeFileSync(
    settingsPath,
    JSON.stringify({
      tokenStreaming: true,
      env: { LETTA_BASE_URL: "http://local" },
    }),
    "utf-8",
  );
  __setSnapshotSecretsIoForTests(fileIo());

  const result = await applySecrets(
    bundle({
      settings: {
        [SECRET_SETTINGS_API_KEY]: "fallback-key",
        [SECRET_SETTINGS_REFRESH_TOKEN]: "fallback-refresh",
      },
    }),
    { homeRoot: appHome },
  );

  expect(result).toEqual({ written: 2, failed: [] });
  const written = JSON.parse(readFileSync(settingsPath, "utf-8"));
  expect(written.refreshToken).toBe("fallback-refresh");
  expect(written.env).toEqual({
    LETTA_BASE_URL: "http://local",
    LETTA_API_KEY: "fallback-key",
  });
  expect(written.tokenStreaming).toBe(true);
});

test("per-item write failures are reported and never printed with their values", async () => {
  const blockedPath = dir.resolve("blocked");
  writeFileSync(blockedPath, "not a directory", "utf-8");

  const writes: string[] = [];
  __testOverrideLocalSecretStorage({
    get: async () => null,
    set: async (name: string, value: string) => {
      if (name.includes("agent:agent-bad:")) {
        const failure = new Error(
          `disk full while writing ${value}`,
        ) as Error & {
          code: string;
        };
        failure.code = "EIO";
        throw failure;
      }
      writes.push(`${name}=${value}`);
    },
    delete: async () => false,
  });

  __setSnapshotSecretsIoForTests(fileIo());
  __setActiveChannelCredentialsStoreModeForTests("keyring");
  __setChannelSecretStoreOverrideForTests({
    get: async () => null,
    set: async (_name, value) => {
      if (value === "xoxb-channel-secret") {
        const failure = new Error(`keyring rejected ${value}`) as Error & {
          code: string;
        };
        failure.code = "EACCES";
        throw failure;
      }
    },
    delete: async () => false,
  });

  const result = await applySecrets(
    bundle({
      settings: {
        [SECRET_SETTINGS_API_KEY]: "settings-api-secret",
        [SECRET_SETTINGS_REFRESH_TOKEN]: "settings-refresh-secret",
      },
      agents: {
        "agent-ok": { OPENAI_KEY: "sk-good" },
        "agent-bad": { BAD_KEY: "sk-bad-secret-value" },
      },
      channels: {
        slack: {
          "account-1": {
            botToken: "xoxb-channel-secret",
            appToken: "xapp-ok-secret",
          },
        },
      },
      meta: {
        channelStoreMode: "keyring",
        capturedAt: "2026-10-25T00:00:00.000Z",
      },
    }),
    // A file where a directory is expected: the settings write fails per item.
    { homeRoot: join(blockedPath, "apphome") },
  );

  expect(result.written).toBe(2); // agent-ok and the channel appToken landed
  const failedNames = result.failed.map(
    (entry) => `${entry.scope}:${entry.name}`,
  );
  expect(failedNames).toContain(`settings:${SECRET_SETTINGS_API_KEY}`);
  expect(failedNames).toContain(`settings:${SECRET_SETTINGS_REFRESH_TOKEN}`);
  expect(failedNames).toContain("agent:agent-bad/BAD_KEY");
  expect(failedNames).toContain("channel:slack/account-1/botToken");
  expect(failedNames).not.toContain("agent:agent-ok/OPENAI_KEY");
  expect(failedNames).not.toContain("channel:slack/account-1/appToken");
  expect(writes.join("\n")).toContain("agent:agent-ok:secrets:OPENAI_KEY");

  // No value may appear in the report, even though both failing backends echoed
  // the value in their own error message.
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain("sk-bad-secret-value");
  expect(serialized).not.toContain("xoxb-channel-secret");
  expect(serialized).not.toContain("settings-api-secret");
  expect(serialized).not.toContain("settings-refresh-secret");
});

test("keyring-sourced channel values report re-authorization on a file-backed target", async () => {
  __setSnapshotSecretsIoForTests(fileIo());
  __setActiveChannelCredentialsStoreModeForTests("file");

  const result = await applySecrets(
    bundle({
      channels: {
        slack: { "account-1": { botToken: "xoxb-placeholder-source" } },
      },
      meta: {
        channelStoreMode: "keyring",
        capturedAt: "2026-10-25T00:00:00.000Z",
      },
    }),
    { homeRoot: dir.resolve("apphome") },
  );

  expect(result.written).toBe(0);
  expect(result.failed).toHaveLength(1);
  expect(result.failed[0]?.scope).toBe("channel");
  expect(result.failed[0]?.name).toBe("slack/account-1/botToken");
  expect(result.failed[0]?.reason).toContain("re-authorize");
  expect(JSON.stringify(result)).not.toContain("xoxb-placeholder-source");
});

test("unreadable agent secrets fail capture with an io_error naming the agent", async () => {
  __setSnapshotSecretsIoForTests(fileIo());
  __testOverrideLocalSecretStorage({
    get: async (name: string) => {
      if (name.includes("agent:agent-broken:")) {
        throw new Error("secret index is corrupt");
      }
      return null;
    },
    set: async () => {},
    delete: async () => false,
  });

  const failure = collectSecrets(
    rootsFor(dir.resolve("apphome"), dir.resolve("storage")),
    ["agent-broken"],
  );

  await expect(failure).rejects.toBeInstanceOf(SnapshotError);
  await expect(failure).rejects.toMatchObject({ code: "io_error" });
  await expect(failure).rejects.toThrow(/agent-broken/);
});

test("corrupt settings.json fails capture when the file fallback is in use", async () => {
  const appHome = dir.resolve("apphome");
  mkdirSync(appHome, { recursive: true });
  const settingsPath = join(appHome, "settings.json");
  writeFileSync(settingsPath, '{"env": ', "utf-8");
  __setSnapshotSecretsIoForTests(fileIo());

  const failure = collectSecrets(rootsFor(appHome, dir.resolve("storage")), []);

  await expect(failure).rejects.toBeInstanceOf(SnapshotError);
  await expect(failure).rejects.toMatchObject({ code: "io_error" });
});

test("corrupt channel accounts fail capture instead of being skipped", async () => {
  const channelsRoot = dir.resolve("channels");
  mkdirSync(join(channelsRoot, "discord"), { recursive: true });
  writeFileSync(
    join(channelsRoot, "discord", "accounts.json"),
    "{broken",
    "utf-8",
  );
  __setSnapshotSecretsIoForTests(fileIo());
  __testOverrideChannelsRoot(channelsRoot);
  __setActiveChannelCredentialsStoreModeForTests("file");

  const failure = collectSecrets(
    rootsFor(dir.resolve("apphome"), dir.resolve("storage")),
    [],
  );

  await expect(failure).rejects.toBeInstanceOf(SnapshotError);
  await expect(failure).rejects.toMatchObject({ code: "io_error" });
});

test("an unreadable keychain fails settings capture with an io_error", async () => {
  __setSnapshotSecretsIoForTests({
    isKeychainAvailable: async () => true,
    getSecureTokens: async () => {
      throw new Error("secure storage is locked");
    },
    setSecureTokens: async () => {},
  });

  const failure = collectSecrets(
    rootsFor(dir.resolve("apphome"), dir.resolve("storage")),
    [],
  );

  await expect(failure).rejects.toBeInstanceOf(SnapshotError);
  await expect(failure).rejects.toMatchObject({ code: "io_error" });
});

test("a keyring channel store without secure storage fails capture cleanly", async () => {
  const channelsRoot = dir.resolve("channels");
  writeChannelAccounts(channelsRoot, "telegram", [
    { channel: "telegram", accountId: "tg-1", token: "tg-plaintext-token" },
  ]);
  __setSnapshotSecretsIoForTests(fileIo());
  __testOverrideChannelsRoot(channelsRoot);
  __setChannelCredentialsStoreModeForTests("keyring");
  __setChannelKeychainAvailableForTests(false);

  const failure = collectSecrets(
    rootsFor(dir.resolve("apphome"), dir.resolve("storage")),
    [],
  );

  await expect(failure).rejects.toBeInstanceOf(SnapshotError);
  await expect(failure).rejects.toMatchObject({ code: "io_error" });
  await expect(failure).rejects.toThrow(/keyring/);
});
