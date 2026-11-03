import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getEmbeddingEndpointApiKey,
  getEmbeddingSecretFallbackPath,
} from "@/backend/local/embedding/secrets";
import { clearSecretsCache } from "@/utils/secrets-store";
import {
  __testResetEmbeddingApiKeyPresence,
  clearEmbeddingApiKey,
  describeEmbeddingApiKeyStorage,
  embeddingApiKeyRowValue,
  getEmbeddingApiKeyPresence,
  getEmbeddingApiKeyStorage,
  refreshEmbeddingApiKeyPresence,
  saveEmbeddingApiKey,
} from "./embedding-secrets";

/**
 * The settings page's endpoint-key row.
 *
 * Two properties matter and are both regressions waiting to happen:
 * **the key is never echoed** (not in the row value, not in the save result, not
 * in the R-36 disclosure) and **presence is never guessed** (a lookup that was
 * not made says "unknown", not "not set"). The secrets store is the real C1
 * implementation under a disposable `HARUYUKI_HOME` +
 * `LETTA_LOCAL_BACKEND_DIR`, with the keychain probe disabled so the file
 * fallback is deterministic.
 */

const AGENT_ID = "w3-d3-embedding-settings-agent";
const SECRET_VALUE = "sk-test-w3-d3-embedding-secret-1234567890";

const ORIGINAL_ENV = {
  AGENT_ID: process.env.AGENT_ID,
  HARUYUKI_HOME: process.env.HARUYUKI_HOME,
  HARUYUKI_SKIP_KEYCHAIN_CHECK: process.env.HARUYUKI_SKIP_KEYCHAIN_CHECK,
  LETTA_LOCAL_BACKEND_DIR: process.env.LETTA_LOCAL_BACKEND_DIR,
};

const tempDirs: string[] = [];

function restoreEnv(key: keyof typeof ORIGINAL_ENV): void {
  const value = ORIGINAL_ENV[key];
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

function makeSandbox(): void {
  const sandboxDir = mkdtempSync(join(tmpdir(), "hryk-w3-d3-secrets-"));
  tempDirs.push(sandboxDir);
  process.env.HARUYUKI_HOME = join(sandboxDir, "home");
  process.env.LETTA_LOCAL_BACKEND_DIR = join(sandboxDir, "local-backend");
  process.env.HARUYUKI_SKIP_KEYCHAIN_CHECK = "1";
  process.env.AGENT_ID = AGENT_ID;
}

beforeEach(() => {
  makeSandbox();
  clearSecretsCache(null);
  __testResetEmbeddingApiKeyPresence();
});

afterEach(() => {
  clearSecretsCache(null);
  __testResetEmbeddingApiKeyPresence();
});

afterAll(() => {
  clearSecretsCache(null);
  restoreEnv("AGENT_ID");
  restoreEnv("HARUYUKI_HOME");
  restoreEnv("HARUYUKI_SKIP_KEYCHAIN_CHECK");
  restoreEnv("LETTA_LOCAL_BACKEND_DIR");
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("the endpoint-key row's presence", () => {
  test("is unknown until something looks, and never claims 'not set'", () => {
    expect(getEmbeddingApiKeyPresence()).toBe("unknown");
    expect(embeddingApiKeyRowValue()).toBe("hidden (write-only)");
  });

  test("a lookup with no stored key reports unset", async () => {
    expect(await refreshEmbeddingApiKeyPresence(AGENT_ID)).toBe("unset");
    expect(embeddingApiKeyRowValue()).toBe("not set");
  });

  test("a save reports set", async () => {
    await saveEmbeddingApiKey(SECRET_VALUE, AGENT_ID);
    expect(getEmbeddingApiKeyPresence()).toBe("set");
    expect(embeddingApiKeyRowValue()).toBe("set (write-only)");
    expect(getEmbeddingApiKeyStorage()).toBe("plaintext-file");
  });

  test("a clear reports unset", async () => {
    await saveEmbeddingApiKey(SECRET_VALUE, AGENT_ID);
    expect(await clearEmbeddingApiKey(AGENT_ID)).toBe(true);
    expect(getEmbeddingApiKeyPresence()).toBe("unset");
    expect(embeddingApiKeyRowValue()).toBe("not set");
  });
});

describe("saving the endpoint key", () => {
  test("stores the value through C1's store", async () => {
    const result = await saveEmbeddingApiKey(SECRET_VALUE, AGENT_ID);
    expect(result.storage).toBe("plaintext-file");
    expect(await getEmbeddingEndpointApiKey(AGENT_ID)).toBe(SECRET_VALUE);
  });

  test("never echoes the key in its result", async () => {
    const result = await saveEmbeddingApiKey(SECRET_VALUE, AGENT_ID);
    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
    expect(result.disclosure).not.toContain(SECRET_VALUE);
    expect(result.disclosure).toContain(getEmbeddingSecretFallbackPath());
  });

  test("never echoes the key in the row value or the disclosure", async () => {
    await saveEmbeddingApiKey(SECRET_VALUE, AGENT_ID);
    const disclosure = await describeEmbeddingApiKeyStorage();
    for (const exhibited of [
      embeddingApiKeyRowValue(),
      disclosure,
      JSON.stringify([
        getEmbeddingApiKeyPresence(),
        getEmbeddingApiKeyStorage(),
      ]),
    ]) {
      expect(exhibited).not.toContain(SECRET_VALUE);
    }
  });

  test("trims the value before storing it", async () => {
    await saveEmbeddingApiKey(`  ${SECRET_VALUE}  `, AGENT_ID);
    expect(await getEmbeddingEndpointApiKey(AGENT_ID)).toBe(SECRET_VALUE);
  });

  test("refuses an empty value instead of storing one", async () => {
    await expect(saveEmbeddingApiKey("   ", AGENT_ID)).rejects.toThrow(
      "must not be empty",
    );
    expect(getEmbeddingApiKeyPresence()).toBe("unknown");
  });
});

describe("clearing the endpoint key", () => {
  test("removes the value and reports whether anything went", async () => {
    expect(await clearEmbeddingApiKey(AGENT_ID)).toBe(false);
    await saveEmbeddingApiKey(SECRET_VALUE, AGENT_ID);
    expect(await clearEmbeddingApiKey(AGENT_ID)).toBe(true);
    expect(await getEmbeddingEndpointApiKey(AGENT_ID)).toBeNull();
  });
});
