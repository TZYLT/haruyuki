import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  extractTarGz,
  listTarGzEntries,
  TarArchiveError,
  type TarArchiveErrorKind,
} from "./tar";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

interface FixtureEntry {
  /** Entry name written into the tar header. */
  readonly name: string;
  readonly data?: string;
  /** Raw typeflag; defaults to a regular file. */
  readonly tarType?: string;
  readonly linkName?: string;
  readonly mode?: number;
  /** ustar `prefix` field, for names longer than the 100-byte name field. */
  readonly prefix?: string;
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
  const type = entry.tarType ?? "0";
  const data =
    entry.data === undefined ? Buffer.alloc(0) : Buffer.from(entry.data);
  header.write(entry.name, 0, "utf8");
  writeOctal(header, 100, 8, entry.mode ?? 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, data.length);
  writeOctal(header, 136, 12, 1_700_000_000);
  header.fill(0x20, 148, 156);
  header.write(type, 156, "ascii");
  header.write(entry.linkName ?? "", 157, "utf8");
  header.write("ustar\0", 257, "latin1");
  header.write("00", 263, "ascii");
  if (entry.prefix !== undefined) header.write(entry.prefix, 345, "utf8");
  const checksum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return header;
}

function buildTar(entries: readonly FixtureEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = buildHeader(entry);
    blocks.push(header);
    const data =
      entry.data === undefined ? Buffer.alloc(0) : Buffer.from(entry.data);
    if (data.length > 0) {
      blocks.push(data);
      const padding = (512 - (data.length % 512)) % 512;
      if (padding > 0) blocks.push(Buffer.alloc(padding));
    }
  }
  blocks.push(Buffer.alloc(512), Buffer.alloc(512));
  return Buffer.concat(blocks);
}

function buildTarGz(entries: readonly FixtureEntry[]): Buffer {
  return gzipSync(buildTar(entries));
}

function paxRecord(key: string, value: string): Buffer {
  const body = `${key}=${value}\n`;
  let length = body.length + 1;
  for (;;) {
    const record = `${length} ${body}`;
    if (record.length === length) return Buffer.from(record);
    length = record.length;
  }
}

async function expectTarError(
  promise: Promise<unknown>,
  kind: TarArchiveErrorKind,
): Promise<TarArchiveError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(TarArchiveError);
    const tarError = error as TarArchiveError;
    expect(tarError.kind).toBe(kind);
    return tarError;
  }
  throw new Error(`Expected a TarArchiveError of kind ${kind}`);
}

const PACKAGE_TREE: FixtureEntry[] = [
  { name: "package/", tarType: "5", mode: 0o755 },
  { name: "package/package.json", data: '{"name":"fixture"}' },
  { name: "package/dist/", tarType: "5", mode: 0o755 },
  { name: "package/dist/index.js", data: "export const answer = 42;\n" },
  {
    name: "package/bin/napi-v6/win32/x64/binding.node",
    data: "win32-x64-binary",
    mode: 0o755,
  },
  {
    name: "package/bin/napi-v6/linux/x64/binding.node",
    data: "linux-x64-binary",
    mode: 0o755,
  },
];

describe("tar extraction", () => {
  test("extracts regular files and directories, stripping the package/ root", async () => {
    const root = makeTempDir("hryk-c2-tar-ok-");
    const destination = join(root, "out");
    const result = await extractTarGz(buildTarGz(PACKAGE_TREE), {
      destinationDir: destination,
    });

    expect(existsSync(join(destination, "package"))).toBe(false);
    expect(readFileSync(join(destination, "package.json"), "utf8")).toBe(
      '{"name":"fixture"}',
    );
    expect(readFileSync(join(destination, "dist/index.js"), "utf8")).toBe(
      "export const answer = 42;\n",
    );
    expect(
      readFileSync(
        join(destination, "bin/napi-v6/win32/x64/binding.node"),
        "utf8",
      ),
    ).toBe("win32-x64-binary");
    expect(result.files).toEqual([
      "package.json",
      "dist/index.js",
      "bin/napi-v6/win32/x64/binding.node",
      "bin/napi-v6/linux/x64/binding.node",
    ]);
    expect(result.directories).toBe(1);
    expect(result.skippedEntries).toBe(0);
    expect(result.bytesWritten).toBe(
      Buffer.byteLength('{"name":"fixture"}') +
        Buffer.byteLength("export const answer = 42;\n") +
        Buffer.byteLength("win32-x64-binary") +
        Buffer.byteLength("linux-x64-binary"),
    );
  });

  test("extracts from an on-disk .tar.gz file", async () => {
    const root = makeTempDir("hryk-c2-tar-file-");
    const archivePath = join(root, "fixture.tgz");
    writeFileSync(archivePath, buildTarGz(PACKAGE_TREE));
    const destination = join(root, "out");
    const result = await extractTarGz(archivePath, {
      destinationDir: destination,
    });
    expect(result.files.length).toBe(4);
    expect(existsSync(join(destination, "dist/index.js"))).toBe(true);
  });

  test("honours a ustar prefix for long names", async () => {
    const root = makeTempDir("hryk-c2-tar-prefix-");
    const longDir = "package/longer/prefix/path";
    const archive = buildTarGz([
      { name: "leaf.txt", prefix: longDir, data: "leaf" },
    ]);
    const destination = join(root, "out");
    await extractTarGz(archive, { destinationDir: destination });
    expect(
      readFileSync(join(destination, "longer/prefix/path/leaf.txt"), "utf8"),
    ).toBe("leaf");
  });

  test("honours a PAX extended path header", async () => {
    const root = makeTempDir("hryk-c2-tar-pax-");
    const longName = `package/${"deep/".repeat(30)}file.txt`;
    const pax = Buffer.concat([paxRecord("path", longName)]);
    const archive = buildTarGz([
      { name: "PaxHeaders/deep", tarType: "x", data: pax.toString("latin1") },
      { name: "placeholder", data: "pax-target" },
    ]);
    const destination = join(root, "out");
    await extractTarGz(archive, { destinationDir: destination });
    expect(
      readFileSync(join(destination, `${"deep/".repeat(30)}file.txt`), "utf8"),
    ).toBe("pax-target");
  });

  test("lists entries without writing to disk", async () => {
    const root = makeTempDir("hryk-c2-tar-list-");
    const destination = join(root, "out");
    const entries = await listTarGzEntries(buildTarGz(PACKAGE_TREE));
    expect(entries.map((entry) => entry.name)).toEqual([
      "package.json",
      "dist",
      "dist/index.js",
      "bin/napi-v6/win32/x64/binding.node",
      "bin/napi-v6/linux/x64/binding.node",
    ]);
    expect(entries[0]?.type).toBe("file");
    expect(entries[1]?.type).toBe("directory");
    expect(entries[0]?.size).toBe(Buffer.byteLength('{"name":"fixture"}'));
    expect(existsSync(destination)).toBe(false);
  });

  test("can keep the leading directory, and can filter entries", async () => {
    const root = makeTempDir("hryk-c2-tar-filter-");
    const destination = join(root, "out");
    const result = await extractTarGz(buildTarGz(PACKAGE_TREE), {
      destinationDir: destination,
      stripLeadingDirectory: false,
      includeEntry: (entry) => entry.name.includes("/win32/"),
    });
    expect(existsSync(join(destination, "package/package.json"))).toBe(false);
    expect(
      existsSync(
        join(destination, "package/bin/napi-v6/win32/x64/binding.node"),
      ),
    ).toBe(true);
    expect(result.skippedEntries).toBe(5);
  });

  test("forwards an abort signal before the first entry", async () => {
    const root = makeTempDir("hryk-c2-tar-abort-");
    const controller = new AbortController();
    controller.abort();
    try {
      await extractTarGz(buildTarGz(PACKAGE_TREE), {
        destinationDir: join(root, "out"),
        signal: controller.signal,
      });
      throw new Error("Expected the extraction to abort");
    } catch (error) {
      expect((error as Error).name).toBe("AbortError");
    }
  });
});

describe("tar zip-slip guards", () => {
  const unsafeNames = [
    "../evil.txt",
    "package/../../evil.txt",
    "/absolute/evil.txt",
    "C:/absolute/evil.txt",
    "C:drive-relative.txt",
    "\\\\server\\share\\evil.txt",
    "package/../escape.txt",
    "package/nested\\..\\..\\escape.txt",
    "package/file:stream",
  ];

  for (const name of unsafeNames) {
    test(`rejects unsafe entry name ${JSON.stringify(name)}`, async () => {
      const root = makeTempDir("hryk-c2-tar-slip-");
      const destination = join(root, "out");
      await expectTarError(
        extractTarGz(buildTarGz([{ name, data: "owned" }]), {
          destinationDir: destination,
        }),
        "unsafe-entry",
      );
      expect(readdirSync(root).sort()).toEqual(["out"]);
      expect(existsSync(join(root, "evil.txt"))).toBe(false);
      expect(existsSync(join(root, "escape.txt"))).toBe(false);
    });
  }

  test("rejects symlink and hardlink entries", async () => {
    const root = makeTempDir("hryk-c2-tar-link-");
    await expectTarError(
      extractTarGz(
        buildTarGz([
          {
            name: "package/link",
            tarType: "2",
            linkName: "/etc/passwd",
          },
        ]),
        { destinationDir: join(root, "symlink") },
      ),
      "unsafe-entry",
    );
    await expectTarError(
      extractTarGz(
        buildTarGz([
          {
            name: "package/link",
            tarType: "1",
            linkName: "package/package.json",
          },
        ]),
        { destinationDir: join(root, "hardlink") },
      ),
      "unsafe-entry",
    );
  });

  test("rejects character-device and unknown entry types", async () => {
    const root = makeTempDir("hryk-c2-tar-type-");
    await expectTarError(
      extractTarGz(buildTarGz([{ name: "package/device", tarType: "3" }]), {
        destinationDir: join(root, "out"),
      }),
      "unsupported-entry",
    );
  });
});

describe("tar corruption guards", () => {
  test("rejects a bad header checksum", async () => {
    const root = makeTempDir("hryk-c2-tar-checksum-");
    const tar = buildTar([{ name: "package/file.txt", data: "ok" }]);
    // Flip a name byte after the checksum was computed.
    tar[10] = "X".charCodeAt(0);
    await expectTarError(
      extractTarGz(gzipSync(tar), { destinationDir: join(root, "out") }),
      "checksum",
    );
  });

  test("rejects a truncated tar stream", async () => {
    const root = makeTempDir("hryk-c2-tar-truncated-");
    const tar = buildTar([{ name: "package/file.txt", data: "x".repeat(600) }]);
    // Valid gzip, but the tar data block ends 500 bytes early.
    const archive = gzipSync(tar.subarray(0, 512 + 100));
    await expectTarError(
      extractTarGz(archive, { destinationDir: join(root, "out") }),
      "truncated",
    );
  });

  test("rejects a truncated gzip stream", async () => {
    const root = makeTempDir("hryk-c2-tar-gzip-truncated-");
    const archive = gzipSync(
      buildTar([{ name: "package/file.txt", data: "data" }]),
    );
    await expectTarError(
      extractTarGz(archive.subarray(0, 40), {
        destinationDir: join(root, "out"),
      }),
      "gzip",
    );
  });

  test("rejects a non-gzip archive", async () => {
    const root = makeTempDir("hryk-c2-tar-gzip-");
    await expectTarError(
      extractTarGz(Buffer.from("this is not gzip"), {
        destinationDir: join(root, "out"),
      }),
      "gzip",
    );
  });
});
