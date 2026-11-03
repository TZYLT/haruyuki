import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appHomeDirName, appHomePath, appHomeRoot } from "@/utils/app-paths";
import { clearSecretsCache } from "@/utils/secrets-store";
import {
  assertInsideEmbeddingCache,
  clearEmbeddingEndpointApiKey,
  EMBEDDING_ENDPOINT_SECRET_NAME,
  EmbeddingCachePathError,
  getEmbeddingCacheDir,
  getEmbeddingEndpointApiKey,
  getEmbeddingModelDir,
  getEmbeddingModelsDir,
  getEmbeddingRuntimeDir,
  getEmbeddingSecretFallbackPath,
  getEmbeddingSecretStorageDisclosure,
  hardenEmbeddingSecretFile,
  isInsideEmbeddingCache,
  resolveEmbeddingCachePath,
  saveEmbeddingEndpointApiKey,
} from "./secrets";

const AGENT_ID = "w1-c1-embedding-secrets-agent";
const SECRET_VALUE = "sk-test-embedding-secret-value-1234567890";

const ORIGINAL_ENV = {
  AGENT_ID: process.env.AGENT_ID,
  HARUYUKI_HOME: process.env.HARUYUKI_HOME,
  HARUYUKI_SKIP_KEYCHAIN_CHECK: process.env.HARUYUKI_SKIP_KEYCHAIN_CHECK,
  LETTA_LOCAL_BACKEND_DIR: process.env.LETTA_LOCAL_BACKEND_DIR,
};

const tempDirs: string[] = [];
let sandboxDir = "";

function restoreEnv(key: keyof typeof ORIGINAL_ENV): void {
  const value = ORIGINAL_ENV[key];
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

function makeSandbox(): void {
  sandboxDir = mkdtempSync(join(tmpdir(), "hryk-w1-c1-secrets-"));
  tempDirs.push(sandboxDir);
  process.env.HARUYUKI_HOME = join(sandboxDir, "home");
  process.env.LETTA_LOCAL_BACKEND_DIR = join(sandboxDir, "local-backend");
  // Deterministic file fallback: never probe or write the real credential store.
  process.env.HARUYUKI_SKIP_KEYCHAIN_CHECK = "1";
  process.env.AGENT_ID = AGENT_ID;
}

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

describe("embedding cache paths", () => {
  beforeEach(() => {
    makeSandbox();
    clearSecretsCache(null);
  });

  afterEach(() => {
    clearSecretsCache(null);
  });

  test("cache root resolves through app-paths and honours HARUYUKI_HOME per call", () => {
    const first = getEmbeddingCacheDir();
    expect(first).toBe(appHomePath(["cache", "embedding"]));
    expect(first.startsWith(appHomeRoot())).toBe(true);

    const relocated = join(sandboxDir, "relocated-home");
    process.env.HARUYUKI_HOME = relocated;
    const second = getEmbeddingCacheDir();
    expect(second).toBe(appHomePath(["cache", "embedding"]));
    expect(second.startsWith(appHomeRoot())).toBe(true);
    expect(second).not.toBe(first);
  });

  test("without HARUYUKI_HOME the root stays under the harness home", () => {
    delete process.env.HARUYUKI_HOME;
    expect(getEmbeddingCacheDir()).toBe(appHomePath(["cache", "embedding"]));
  });

  test("source never spells the harness directory name as a literal", () => {
    const source = readFileSync(join(import.meta.dir, "secrets.ts"), "utf8");
    expect(source.includes(appHomeDirName())).toBe(false);
  });

  test("runtime and model directories live below the cache root", () => {
    const root = getEmbeddingCacheDir();
    expect(getEmbeddingRuntimeDir("1.31.1")).toBe(
      join(root, "runtime", "1.31.1"),
    );
    expect(getEmbeddingModelsDir()).toBe(join(root, "models"));
    expect(getEmbeddingModelDir("bge-small-zh-v1.5")).toBe(
      join(root, "models", "bge-small-zh-v1.5"),
    );
  });

  test("path segments that could escape the cache root are rejected", () => {
    expect(() => resolveEmbeddingCachePath("..", "escape")).toThrow(
      EmbeddingCachePathError,
    );
    expect(() => resolveEmbeddingCachePath("a/b")).toThrow(
      EmbeddingCachePathError,
    );
    expect(() => resolveEmbeddingCachePath("/absolute")).toThrow(
      EmbeddingCachePathError,
    );
    expect(() => resolveEmbeddingCachePath("..")).toThrow(
      EmbeddingCachePathError,
    );
    expect(() => resolveEmbeddingCachePath("")).toThrow(
      EmbeddingCachePathError,
    );
    expect(() => getEmbeddingModelDir("../outside")).toThrow(
      EmbeddingCachePathError,
    );
  });

  test("pre-built paths are validated against the cache root", () => {
    const inside = join(getEmbeddingCacheDir(), "models", "x", "model.onnx");
    expect(assertInsideEmbeddingCache(inside)).toBe(inside);
    expect(isInsideEmbeddingCache(inside)).toBe(true);

    const outside = join(sandboxDir, "outside.txt");
    expect(() => assertInsideEmbeddingCache(outside)).toThrow(
      EmbeddingCachePathError,
    );
    expect(isInsideEmbeddingCache(outside)).toBe(false);
  });
});

describe("embedding endpoint secrets", () => {
  beforeEach(() => {
    makeSandbox();
    clearSecretsCache(null);
  });

  afterEach(() => {
    clearSecretsCache(null);
  });

  test("round-trips the key through the shared secrets store", async () => {
    expect(await getEmbeddingEndpointApiKey(AGENT_ID)).toBeNull();

    const storage = await saveEmbeddingEndpointApiKey(
      `  ${SECRET_VALUE}  `,
      AGENT_ID,
    );
    expect(storage).toBe("plaintext-file");
    expect(await getEmbeddingEndpointApiKey(AGENT_ID)).toBe(SECRET_VALUE);

    const filePath = getEmbeddingSecretFallbackPath();
    expect(existsSync(filePath)).toBe(true);
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as {
      secrets?: Record<string, string>;
    };
    expect(
      parsed.secrets?.[
        `agent:${AGENT_ID}:secrets:${EMBEDDING_ENDPOINT_SECRET_NAME}`
      ],
    ).toBe(SECRET_VALUE);

    expect(await clearEmbeddingEndpointApiKey(AGENT_ID)).toBe(true);
    expect(await getEmbeddingEndpointApiKey(AGENT_ID)).toBeNull();
    expect(await clearEmbeddingEndpointApiKey(AGENT_ID)).toBe(false);
    const cleared = JSON.parse(readFileSync(filePath, "utf8")) as {
      secrets?: Record<string, string>;
    };
    expect(
      cleared.secrets?.[
        `agent:${AGENT_ID}:secrets:${EMBEDDING_ENDPOINT_SECRET_NAME}`
      ],
    ).toBeUndefined();
  });

  test("re-applies mode 0600 to an already-existing secret file", () => {
    const filePath = getEmbeddingSecretFallbackPath();
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify({ secrets: {} }), { mode: 0o644 });
    if (process.platform !== "win32") chmodSync(filePath, 0o644);

    expect(hardenEmbeddingSecretFile()).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
    }
  });

  test("hardenEmbeddingSecretFile is a no-op when the file does not exist", () => {
    expect(existsSync(getEmbeddingSecretFallbackPath())).toBe(false);
    expect(hardenEmbeddingSecretFile()).toBe(false);
  });

  test("rejects an empty key instead of writing a blank secret", async () => {
    await expect(saveEmbeddingEndpointApiKey("   ", AGENT_ID)).rejects.toThrow(
      /must not be empty/,
    );
  });

  test("discloses plaintext 0600 storage without leaking the key", async () => {
    await saveEmbeddingEndpointApiKey(SECRET_VALUE, AGENT_ID);
    const disclosure = await getEmbeddingSecretStorageDisclosure();
    expect(disclosure.storage).toBe("plaintext-file");
    expect(disclosure.filePath).toBe(getEmbeddingSecretFallbackPath());
    expect(disclosure.disclosure).toContain("0600");
    expect(disclosure.disclosure.toLowerCase()).toContain("unencrypted");
    expect(disclosure.disclosure).not.toContain(SECRET_VALUE);
  });
});
