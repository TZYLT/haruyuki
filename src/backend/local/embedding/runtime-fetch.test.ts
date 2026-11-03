import { afterAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import type { DownloadFileOptions, DownloadFileResult } from "./download-http";
import {
  buildPackageMetadataUrl,
  cleanupEmbeddingRuntimeStagingDirs,
  fetchEmbeddingRuntime,
  fetchNpmPackageMetadata,
  isEmbeddingRuntimePlatformSupported,
  type NpmPackageMetadata,
  parseRuntimePackageSpec,
  parseSha512Integrity,
  type RuntimeDownloader,
  EmbeddingRuntimeFetchError as RuntimeFetchError,
  type RuntimeMetadataFetcher,
  readEmbeddingRuntimeManifest,
  resolveRuntimePackage,
  shouldExtractEntryForPlatform,
  uninstallEmbeddingRuntime,
} from "./runtime-fetch";
import { getEmbeddingRuntimeDir } from "./secrets";

const tempDirs: string[] = [];
const servers: Array<() => Promise<void>> = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const close of servers.splice(0)) await close();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Synthetic npm fixtures: a hand-written tar.gz (no tar dependency) + metadata.
// ---------------------------------------------------------------------------

interface FixtureEntry {
  readonly name: string;
  readonly data?: string;
  readonly tarType?: string;
}

function writeOctal(
  target: Buffer,
  offset: number,
  length: number,
  value: number,
): void {
  const text = value
    .toString(8)
    .padStart(length - 1, "0")
    .slice(-(length - 1));
  target.write(text, offset, "ascii");
  target.writeUInt8(0, offset + length - 1);
}

function buildHeader(entry: FixtureEntry): Buffer {
  const header = Buffer.alloc(512);
  const data =
    entry.data === undefined ? Buffer.alloc(0) : Buffer.from(entry.data);
  header.write(entry.name, 0, "utf8");
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, data.length);
  writeOctal(header, 136, 12, 1_700_000_000);
  header.fill(0x20, 148, 156);
  header.write(entry.tarType ?? "0", 156, "ascii");
  header.write("ustar\0", 257, "latin1");
  header.write("00", 263, "ascii");
  const checksum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return header;
}

function buildTarGz(entries: readonly FixtureEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    blocks.push(buildHeader(entry));
    const data =
      entry.data === undefined ? Buffer.alloc(0) : Buffer.from(entry.data);
    if (data.length > 0) {
      blocks.push(data);
      const padding = (512 - (data.length % 512)) % 512;
      if (padding > 0) blocks.push(Buffer.alloc(padding));
    }
  }
  blocks.push(Buffer.alloc(512), Buffer.alloc(512));
  return gzipSync(Buffer.concat(blocks));
}

function sha512Integrity(bytes: Buffer): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

interface FakePackage {
  readonly name: string;
  readonly version: string;
  readonly tarball: Buffer;
}

const MIRROR_REGISTRY = {
  id: "npmmirror",
  metadataBaseUrl: "https://registry.npmmirror.com",
};
const NPMJS_REGISTRY = {
  id: "npmjs",
  metadataBaseUrl: "https://registry.npmjs.org",
};

function tarballUrl(pkg: FakePackage): string {
  const shortName = pkg.name.split("/").pop() ?? pkg.name;
  return `https://registry.npmjs.org/${pkg.name}/-/${shortName}-${pkg.version}.tgz`;
}

function metadataFor(pkg: FakePackage): NpmPackageMetadata {
  return {
    name: pkg.name,
    version: pkg.version,
    tarballUrl: tarballUrl(pkg),
    integrity: sha512Integrity(pkg.tarball),
  };
}

interface FakeRegistry {
  readonly fetchMetadata: RuntimeMetadataFetcher;
  readonly download: RuntimeDownloader;
  readonly metadataCalls: string[];
  readonly downloadCalls: string[];
}

/**
 * A registry fake that mimics the real order: npmmirror is offline and npmjs
 * serves the metadata. `tarballs` maps tarball URL → bytes and is also what the
 * fake downloader writes.
 */
function createFakeRegistry(
  packages: readonly FakePackage[],
  options: {
    readonly npmMirrorMetadata?: (
      pkg: FakePackage,
    ) => NpmPackageMetadata | Promise<NpmPackageMetadata>;
    readonly npmjsIntegrity?: (pkg: FakePackage) => string | null;
    readonly downloadError?: Error;
  } = {},
): FakeRegistry {
  const metadataCalls: string[] = [];
  const downloadCalls: string[] = [];
  const byCoordinate = new Map(
    packages.map((pkg) => [`${pkg.name}@${pkg.version}`, pkg] as const),
  );
  const byTarballUrl = new Map(
    packages.map((pkg) => [tarballUrl(pkg), pkg] as const),
  );

  const fetchMetadata: RuntimeMetadataFetcher = async (metadataUrl) => {
    metadataCalls.push(metadataUrl);
    const url = new URL(metadataUrl);
    const segments = url.pathname
      .split("/")
      .filter((segment) => segment.length > 0)
      .map((segment) => decodeURIComponent(segment));
    const version = segments.pop();
    const name = segments.join("/");
    const pkg = byCoordinate.get(`${name}@${version}`);
    if (!pkg) throw new Error(`no fake metadata for ${name}@${version}`);
    if (metadataUrl.startsWith("https://registry.npmmirror.com")) {
      if (options.npmMirrorMetadata) return options.npmMirrorMetadata(pkg);
      throw new Error("npmmirror offline in tests");
    }
    return {
      ...metadataFor(pkg),
      integrity:
        options.npmjsIntegrity === undefined
          ? metadataFor(pkg).integrity
          : options.npmjsIntegrity(pkg),
    };
  };

  const download: RuntimeDownloader = async (
    downloadOptions: DownloadFileOptions,
  ): Promise<DownloadFileResult> => {
    const url = String(downloadOptions.url);
    downloadCalls.push(url);
    if (options.downloadError) throw options.downloadError;
    const pkg = byTarballUrl.get(url);
    if (!pkg) throw new Error(`no fake tarball for ${url}`);
    writeFileSync(downloadOptions.outputPath, pkg.tarball);
    downloadOptions.onProgress?.({
      bytesWritten: pkg.tarball.length,
      totalBytes: pkg.tarball.length,
    });
    return {
      outputPath: downloadOptions.outputPath,
      bytesWritten: pkg.tarball.length,
      totalBytes: pkg.tarball.length,
      statusCode: 200,
      rangeStart: 0,
      resumable: false,
      finalUrl: url,
      attempts: 1,
    };
  };

  return { fetchMetadata, download, metadataCalls, downloadCalls };
}

const ORT_PACKAGE: FakePackage = {
  name: "onnxruntime-node",
  version: "1.31.1",
  tarball: buildTarGz([
    { name: "package/", tarType: "5" },
    { name: "package/package.json", data: '{"name":"onnxruntime-node"}' },
    { name: "package/dist/index.js", data: "ort-js" },
    { name: "package/bin/napi-v6/win32/x64/onnxruntime.dll", data: "win-dll" },
    {
      name: "package/bin/napi-v6/win32/x64/onnxruntime_binding.node",
      data: "win-binding",
    },
    {
      name: "package/bin/napi-v6/win32/arm64/onnxruntime.dll",
      data: "win-arm-dll",
    },
    {
      name: "package/bin/napi-v6/linux/x64/libonnxruntime.so",
      data: "linux-so",
    },
    {
      name: "package/bin/napi-v6/darwin/arm64/libonnxruntime.dylib",
      data: "mac-dylib",
    },
  ]),
};

const COMMON_PACKAGE: FakePackage = {
  name: "onnxruntime-common",
  version: "1.30.0",
  tarball: buildTarGz([
    { name: "package/package.json", data: '{"name":"onnxruntime-common"}' },
    { name: "package/dist/index.js", data: "common-js" },
    { name: "package/dist/index.js.map", data: "{}" },
  ]),
};

const TOKENIZERS_PACKAGE: FakePackage = {
  name: "@huggingface/tokenizers",
  version: "0.2.0",
  tarball: buildTarGz([
    {
      name: "package/package.json",
      data: '{"name":"@huggingface/tokenizers"}',
    },
    { name: "package/index.js", data: "tokenizers-js" },
  ]),
};

const RUNTIME_PACKAGES = [ORT_PACKAGE, COMMON_PACKAGE, TOKENIZERS_PACKAGE];
const RUNTIME_PACKAGE_SPECS = RUNTIME_PACKAGES.map(
  (pkg) => `${pkg.name}@${pkg.version}`,
);

async function startServer(
  handler: http.RequestListener,
): Promise<{ url: string }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  servers.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { url: `http://127.0.0.1:${port}` };
}

function stagingSiblings(runtimeDir: string): string[] {
  const parent = dirname(runtimeDir);
  if (!existsSync(parent)) return [];
  return readdirSync(parent).filter((name) => name.includes(".tmp-"));
}

async function expectRuntimeError(
  promise: Promise<unknown>,
  kind: RuntimeFetchError["kind"],
): Promise<RuntimeFetchError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeFetchError);
    const runtimeError = error as RuntimeFetchError;
    expect(runtimeError.kind).toBe(kind);
    return runtimeError;
  }
  throw new Error(`Expected an EmbeddingRuntimeFetchError of kind ${kind}`);
}

// ---------------------------------------------------------------------------
// Package spec / registry / platform helpers
// ---------------------------------------------------------------------------

describe("runtime package specs", () => {
  test("parses name@exact-version, including scoped packages", () => {
    expect(parseRuntimePackageSpec("onnxruntime-node@1.31.1")).toEqual({
      name: "onnxruntime-node",
      version: "1.31.1",
    });
    expect(parseRuntimePackageSpec("@huggingface/tokenizers@0.2.0")).toEqual({
      name: "@huggingface/tokenizers",
      version: "0.2.0",
    });
    expect(
      parseRuntimePackageSpec({
        name: "onnxruntime-common",
        version: "1.30.0",
      }),
    ).toEqual({ name: "onnxruntime-common", version: "1.30.0" });
  });

  test("rejects ranges, missing versions and invalid names", () => {
    for (const spec of [
      "onnxruntime-node",
      "onnxruntime-node@^1.31.1",
      "onnxruntime-node@1.31",
      "onnxruntime-node@latest",
      "@bad@1.0.0",
    ]) {
      expect(() => parseRuntimePackageSpec(spec)).toThrow(RuntimeFetchError);
    }
  });

  test("builds encoded metadata URLs for both registries", () => {
    const spec = { name: "@huggingface/tokenizers", version: "0.2.0" };
    expect(buildPackageMetadataUrl(MIRROR_REGISTRY, spec)).toBe(
      "https://registry.npmmirror.com/%40huggingface%2Ftokenizers/0.2.0",
    );
    expect(buildPackageMetadataUrl(NPMJS_REGISTRY, spec)).toBe(
      "https://registry.npmjs.org/%40huggingface%2Ftokenizers/0.2.0",
    );
  });

  test("exposes the supported platform/arch matrix", () => {
    expect(isEmbeddingRuntimePlatformSupported("win32", "x64")).toBe(true);
    expect(isEmbeddingRuntimePlatformSupported("win32", "arm64")).toBe(true);
    expect(isEmbeddingRuntimePlatformSupported("linux", "x64")).toBe(true);
    expect(isEmbeddingRuntimePlatformSupported("linux", "arm64")).toBe(true);
    expect(isEmbeddingRuntimePlatformSupported("darwin", "arm64")).toBe(true);
    expect(isEmbeddingRuntimePlatformSupported("darwin", "x64")).toBe(false);
    expect(isEmbeddingRuntimePlatformSupported("win32", "ia32")).toBe(false);
  });

  test("trims platform-specific directory pairs", () => {
    const cases: Array<[string, boolean]> = [
      ["bin/napi-v6/win32/x64/onnxruntime.dll", true],
      ["bin/napi-v6/win32/arm64/onnxruntime.dll", false],
      ["bin/napi-v6/linux/x64/libonnxruntime.so", false],
      ["bin/napi-v6/darwin/arm64/libonnxruntime.dylib", false],
      ["dist/index.js", true],
      ["package.json", true],
    ];
    for (const [entryName, expected] of cases) {
      expect(shouldExtractEntryForPlatform(entryName, "win32", "x64")).toBe(
        expected,
      );
    }
  });

  test("selects the sha512 token from an SRI string", () => {
    const digest = createHash("sha512").update("abc").digest("base64");
    expect(parseSha512Integrity(`sha1-deadbeef sha512-${digest}`)).toBe(
      `sha512-${digest}`,
    );
    expect(parseSha512Integrity(`sha512-${digest}`)).toBe(`sha512-${digest}`);
    expect(() => parseSha512Integrity("sha1-deadbeef")).toThrow(
      RuntimeFetchError,
    );
    expect(() => parseSha512Integrity("sha512-not-a-real-digest")).toThrow(
      RuntimeFetchError,
    );
  });
});

describe("npm metadata resolution", () => {
  test("tries npmmirror first and falls back to npmjs", async () => {
    const registry = createFakeRegistry([TOKENIZERS_PACKAGE]);
    const resolved = await resolveRuntimePackage(
      "@huggingface/tokenizers@0.2.0",
      {
        fetchMetadata: registry.fetchMetadata,
      },
    );
    expect(resolved.registry).toBe("npmjs");
    expect(resolved.integrity).toBe(
      sha512Integrity(TOKENIZERS_PACKAGE.tarball),
    );
    expect(registry.metadataCalls.length).toBe(2);
    expect(registry.metadataCalls[0]).toContain("registry.npmmirror.com");
    expect(registry.metadataCalls[1]).toContain("registry.npmjs.org");
  });

  test("falls back when the mirror metadata has no sha512", async () => {
    const registry = createFakeRegistry([TOKENIZERS_PACKAGE], {
      npmMirrorMetadata: (pkg) => ({
        ...metadataFor(pkg),
        integrity: null,
      }),
    });
    const resolved = await resolveRuntimePackage(
      "@huggingface/tokenizers@0.2.0",
      {
        fetchMetadata: registry.fetchMetadata,
      },
    );
    expect(resolved.registry).toBe("npmjs");
  });

  test("reports every registry when all sources fail", async () => {
    const fetchMetadata: RuntimeMetadataFetcher = async () => {
      throw new Error("registry unreachable");
    };
    const error = await expectRuntimeError(
      resolveRuntimePackage("onnxruntime-node@1.31.1", { fetchMetadata }),
      "metadata",
    );
    expect(error.message).toContain("npmmirror");
    expect(error.message).toContain("npmjs");
  });

  test("refuses a tarball URL that is neither https nor loopback http", async () => {
    const fetchMetadata: RuntimeMetadataFetcher = async () => ({
      name: "onnxruntime-node",
      version: "1.31.1",
      tarballUrl: "http://mirror.example.com/onnxruntime-node.tgz",
      integrity: sha512Integrity(Buffer.from("x")),
    });
    const error = await expectRuntimeError(
      resolveRuntimePackage("onnxruntime-node@1.31.1", { fetchMetadata }),
      "metadata",
    );
    expect(error.message).toContain("https");
  });

  test("reads metadata through C1's client against a loopback mock", async () => {
    const payload = JSON.stringify({
      name: "onnxruntime-node",
      version: "1.31.1",
      dist: {
        tarball:
          "https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-1.31.1.tgz",
        integrity: sha512Integrity(Buffer.from("payload")),
      },
    });
    const server = await startServer((request, response) => {
      if (request.url?.endsWith("/broken")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("not json");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(payload);
    });
    const metadata = await fetchNpmPackageMetadata(
      `${server.url}/onnxruntime-node/1.31.1`,
    );
    expect(metadata.name).toBe("onnxruntime-node");
    expect(metadata.version).toBe("1.31.1");
    expect(metadata.integrity?.startsWith("sha512-")).toBe(true);
    await expectRuntimeError(
      fetchNpmPackageMetadata(`${server.url}/broken`),
      "metadata",
    );
  });
});

// ---------------------------------------------------------------------------
// Install lifecycle
// ---------------------------------------------------------------------------

describe("fetchEmbeddingRuntime", () => {
  test("installs, trims other platforms and writes an atomic manifest", async () => {
    const root = makeTempDir("hryk-c2-runtime-install-");
    const runtimeDir = join(root, "runtime", "1.31.1");
    const registry = createFakeRegistry(RUNTIME_PACKAGES);
    const phases: string[] = [];

    const result = await fetchEmbeddingRuntime({
      runtimeVersion: "1.31.1",
      runtimeDir,
      packages: RUNTIME_PACKAGE_SPECS,
      deps: {
        platform: "win32",
        arch: "x64",
        fetchMetadata: registry.fetchMetadata,
        download: registry.download,
      },
      onProgress: (progress) => phases.push(progress.phase),
    });

    expect(result.alreadyInstalled).toBe(false);
    expect(result.manifest.platform).toBe("win32");
    expect(result.manifest.arch).toBe("x64");
    expect(result.manifest.packages.map((pkg) => pkg.name)).toEqual([
      "onnxruntime-node",
      "onnxruntime-common",
      "@huggingface/tokenizers",
    ]);
    expect(
      result.manifest.packages.every((pkg) => pkg.registry === "npmjs"),
    ).toBe(true);
    expect(result.manifest.files).toBe(9);
    expect(result.manifest.skippedEntries).toBe(3);
    expect(result.manifest.unpackedBytes).toBeGreaterThan(0);

    const nodeModules = join(runtimeDir, "node_modules");
    expect(
      existsSync(
        join(
          nodeModules,
          "onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime.dll",
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(
          nodeModules,
          "onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime_binding.node",
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(join(nodeModules, "onnxruntime-node/bin/napi-v6/linux")),
    ).toBe(false);
    expect(
      existsSync(join(nodeModules, "onnxruntime-node/bin/napi-v6/darwin")),
    ).toBe(false);
    expect(
      existsSync(join(nodeModules, "onnxruntime-node/bin/napi-v6/win32/arm64")),
    ).toBe(false);
    expect(
      existsSync(join(nodeModules, "onnxruntime-node/dist/index.js")),
    ).toBe(true);
    expect(existsSync(join(runtimeDir, ".tarballs"))).toBe(false);
    expect(stagingSiblings(runtimeDir)).toEqual([]);
    expect(phases).toContain("metadata");
    expect(phases).toContain("download");
    expect(phases).toContain("verify");
    expect(phases).toContain("extract");
    expect(phases).toContain("commit");

    const manifestOnDisk = JSON.parse(
      readFileSync(join(runtimeDir, "runtime-manifest.json"), "utf8"),
    ) as { readonly packages: readonly { readonly name: string }[] };
    expect(manifestOnDisk.packages.map((pkg) => pkg.name)).toEqual([
      "onnxruntime-node",
      "onnxruntime-common",
      "@huggingface/tokenizers",
    ]);
  });

  test("returns alreadyInstalled when the manifest matches", async () => {
    const root = makeTempDir("hryk-c2-runtime-idempotent-");
    const runtimeDir = join(root, "runtime", "1.31.1");
    const registry = createFakeRegistry(RUNTIME_PACKAGES);
    const options = {
      runtimeVersion: "1.31.1",
      runtimeDir,
      packages: RUNTIME_PACKAGE_SPECS,
      deps: {
        platform: "win32",
        arch: "x64",
        fetchMetadata: registry.fetchMetadata,
        download: registry.download,
      },
    } as const;

    await fetchEmbeddingRuntime(options);
    const callsAfterInstall = registry.metadataCalls.length;
    const second = await fetchEmbeddingRuntime(options);
    expect(second.alreadyInstalled).toBe(true);
    expect(registry.metadataCalls.length).toBe(callsAfterInstall);

    const forced = await fetchEmbeddingRuntime({ ...options, force: true });
    expect(forced.alreadyInstalled).toBe(false);
    expect(registry.metadataCalls.length).toBeGreaterThan(callsAfterInstall);
  });

  test("rejects an integrity mismatch and leaves no half-install", async () => {
    const root = makeTempDir("hryk-c2-runtime-integrity-");
    const runtimeDir = join(root, "runtime", "1.31.1");
    const registry = createFakeRegistry(RUNTIME_PACKAGES, {
      npmjsIntegrity: () => sha512Integrity(Buffer.from("wrong bytes")),
    });
    const error = await expectRuntimeError(
      fetchEmbeddingRuntime({
        runtimeVersion: "1.31.1",
        runtimeDir,
        packages: RUNTIME_PACKAGE_SPECS,
        deps: {
          platform: "win32",
          arch: "x64",
          fetchMetadata: registry.fetchMetadata,
          download: registry.download,
        },
      }),
      "integrity",
    );
    expect(error.message).toContain("sha512");
    expect(existsSync(runtimeDir)).toBe(false);
    expect(stagingSiblings(runtimeDir)).toEqual([]);
  });

  test("classifies a download failure and cleans up staging", async () => {
    const root = makeTempDir("hryk-c2-runtime-download-");
    const runtimeDir = join(root, "runtime", "1.31.1");
    const registry = createFakeRegistry(RUNTIME_PACKAGES, {
      downloadError: new Error("ECONNRESET while reading tarball"),
    });
    const error = await expectRuntimeError(
      fetchEmbeddingRuntime({
        runtimeVersion: "1.31.1",
        runtimeDir,
        packages: RUNTIME_PACKAGE_SPECS,
        deps: {
          platform: "win32",
          arch: "x64",
          fetchMetadata: registry.fetchMetadata,
          download: registry.download,
        },
      }),
      "download",
    );
    expect(error.message).toContain("ECONNRESET");
    expect(error.cause).toBeInstanceOf(Error);
    expect(existsSync(runtimeDir)).toBe(false);
    expect(stagingSiblings(runtimeDir)).toEqual([]);
  });

  test("classifies an extraction failure and cleans up staging", async () => {
    const root = makeTempDir("hryk-c2-runtime-extract-");
    const runtimeDir = join(root, "runtime", "1.31.1");
    const notATarball = Buffer.from("this is not a tar.gz payload");
    const registry = createFakeRegistry([
      {
        name: "onnxruntime-node",
        version: "1.31.1",
        tarball: notATarball,
      },
    ]);
    const error = await expectRuntimeError(
      fetchEmbeddingRuntime({
        runtimeVersion: "1.31.1",
        runtimeDir,
        packages: ["onnxruntime-node@1.31.1"],
        deps: {
          platform: "win32",
          arch: "x64",
          fetchMetadata: registry.fetchMetadata,
          download: registry.download,
        },
      }),
      "extract",
    );
    expect(error.message).toContain("extract");
    expect(existsSync(runtimeDir)).toBe(false);
    expect(stagingSiblings(runtimeDir)).toEqual([]);
  });

  test("refuses an unsupported platform before touching the network", async () => {
    const root = makeTempDir("hryk-c2-runtime-platform-");
    const runtimeDir = join(root, "runtime", "1.31.1");
    const registry = createFakeRegistry(RUNTIME_PACKAGES);
    await expectRuntimeError(
      fetchEmbeddingRuntime({
        runtimeVersion: "1.31.1",
        runtimeDir,
        packages: RUNTIME_PACKAGE_SPECS,
        deps: {
          platform: "darwin",
          arch: "x64",
          fetchMetadata: registry.fetchMetadata,
          download: registry.download,
        },
      }),
      "platform",
    );
    expect(registry.metadataCalls).toEqual([]);
    expect(registry.downloadCalls).toEqual([]);
  });
});

describe("runtime uninstall and cleanup", () => {
  test("uninstalls one runtime version directory", async () => {
    const version = "w2-c2-uninstall-test";
    const runtimeDir = await installIntoSandbox(version);
    expect(existsSync(runtimeDir)).toBe(true);
    expect(await uninstallEmbeddingRuntime(version)).toBe(true);
    expect(existsSync(runtimeDir)).toBe(false);
    expect(await uninstallEmbeddingRuntime(version)).toBe(false);
    expect(await readEmbeddingRuntimeManifest(version)).toBeNull();
  });

  test("removes stale staging directories only", async () => {
    const version = "w2-c2-cleanup-test";
    const runtimeDir = await installIntoSandbox(version);
    const stale = `${runtimeDir}.tmp-${randomUUID()}`;
    const fresh = `${runtimeDir}.tmp-${randomUUID()}`;
    const decoy = `${runtimeDir}-not-ours`;
    await mkdir(stale, { recursive: true });
    await mkdir(fresh, { recursive: true });
    await mkdir(decoy, { recursive: true });

    const removed = await cleanupEmbeddingRuntimeStagingDirs({
      runtimeVersion: version,
      maxAgeMs: 0,
      now: Date.now() + 1_000,
    });
    expect(removed).toContain(stale);
    expect(removed).toContain(fresh);
    expect(removed).not.toContain(decoy);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(decoy)).toBe(true);
  });
});

/** Install the tokenizers-only closure into the real (test-home) cache path. */
async function installIntoSandbox(version: string): Promise<string> {
  const registry = createFakeRegistry([TOKENIZERS_PACKAGE]);
  const result = await fetchEmbeddingRuntime({
    runtimeVersion: version,
    packages: ["@huggingface/tokenizers@0.2.0"],
    deps: {
      platform: "win32",
      arch: "x64",
      fetchMetadata: registry.fetchMetadata,
      download: registry.download,
    },
  });
  expect(result.runtimeDir).toBe(getEmbeddingRuntimeDir(version));
  return result.runtimeDir;
}
