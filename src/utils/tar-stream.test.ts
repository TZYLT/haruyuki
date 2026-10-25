import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { TestDirectory } from "@/test-utils/test-fs";
import {
  encodeTarHeader,
  isTarStreamError,
  readTarGz,
  type TarEntryDigest,
  type TarEntryInput,
  type TarStreamErrorCode,
  writeTarGz,
} from "./tar-stream";

const BLOCK = 512;

/** Feed a fixed entry list to `writeTarGz` as its async iterable. */
function makeEntries(
  items: readonly TarEntryInput[],
): AsyncIterable<TarEntryInput> {
  return {
    [Symbol.asyncIterator]: async function* iterate() {
      for (const item of items) {
        yield item;
      }
    },
  };
}

/** Pack entries into `name` inside `dir`, capturing the reported digests. */
async function pack(
  dir: TestDirectory,
  name: string,
  entries: readonly TarEntryInput[],
): Promise<{ file: string; reported: TarEntryDigest[] }> {
  const file = dir.resolve(name);
  const reported: TarEntryDigest[] = [];
  await writeTarGz({
    entries: makeEntries(entries),
    outFile: file,
    onEntry: (entry) => {
      reported.push(entry);
    },
  });
  return { file, reported };
}

interface ReadResult {
  path: string;
  type: "file" | "dir";
  size: number;
  bytes: Buffer;
}

/** Read every entry of a package, materialising file bodies. */
async function unpack(file: string): Promise<ReadResult[]> {
  const out: ReadResult[] = [];
  await readTarGz({
    file,
    onEntry: async (entry) => {
      const chunks: Buffer[] = [];
      if (entry.type === "file") {
        for await (const chunk of entry.open()) {
          chunks.push(Buffer.from(chunk));
        }
      }
      out.push({
        path: entry.path,
        type: entry.type,
        size: entry.size,
        bytes: Buffer.concat(chunks),
      });
    },
  });
  return out;
}

/** Build an uncompressed tar body from header blocks plus bodies. */
function rawTar(
  entries: readonly { path: string; type: "file" | "dir"; content?: Buffer }[],
  options: { readonly endBlocks?: number } = {},
): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const content = entry.content ?? Buffer.alloc(0);
    blocks.push(
      ...encodeTarHeader({
        path: entry.path,
        type: entry.type,
        size: content.length,
      }),
    );
    if (content.length > 0) {
      blocks.push(content);
      const pad = (BLOCK - (content.length % BLOCK)) % BLOCK;
      if (pad > 0) {
        blocks.push(Buffer.alloc(pad));
      }
    }
  }
  const endBlocks = options.endBlocks ?? 2;
  if (endBlocks > 0) {
    blocks.push(Buffer.alloc(BLOCK * endBlocks));
  }
  return Buffer.concat(blocks);
}

/** Write a gzipped archive built by hand, for malformed-input cases. */
function writeRawPackage(
  dir: TestDirectory,
  name: string,
  tar: Buffer,
): string {
  const file = dir.resolve(name);
  writeFileSync(file, gzipSync(tar));
  return file;
}

/** Recompute the ustar checksum of a header block. */
function computeChecksum(block: Buffer): number {
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : block.readUInt8(index);
  }
  return sum;
}

/** Read the checksum a header stores (six octal digits, then NUL and space). */
function storedChecksum(block: Buffer): number {
  return Number.parseInt(block.subarray(148, 154).toString("ascii"), 8);
}

/** Read a NUL-terminated header field. */
function textField(block: Buffer, offset: number, length: number): string {
  const field = block.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return (end === -1 ? field : field.subarray(0, end)).toString("utf8");
}

/** Parse a numeric header field. */
function octalField(block: Buffer, offset: number, length: number): number {
  const text = textField(block, offset, length).trim();
  return text.length === 0 ? 0 : Number.parseInt(text, 8);
}

/** Assert a promise rejects with a codec error carrying `code`. */
async function expectCode(
  work: Promise<unknown>,
  code: TarStreamErrorCode,
): Promise<void> {
  try {
    await work;
  } catch (error) {
    expect(isTarStreamError(error)).toBe(true);
    expect((error as { code?: TarStreamErrorCode }).code).toBe(code);
    return;
  }
  throw new Error(`expected a TarStreamError with code ${code}`);
}

/** Locate the system tar (bsdtar on Windows); undefined when unavailable. */
function findTar(): string | undefined {
  try {
    const result = Bun.spawnSync(["tar", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return result.success ? "tar" : undefined;
  } catch {
    return undefined;
  }
}

const SYSTEM_TAR = findTar();

describe("writeTarGz / readTarGz round trip", () => {
  test("single file round-trips its bytes and digest", async () => {
    const dir = new TestDirectory();
    try {
      const content = Buffer.from("hello haruyuki\n");
      const { file, reported } = await pack(dir, "one.hryk", [
        { path: "home/hello.txt", type: "file", content },
      ]);

      const entries = await unpack(file);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.path).toBe("home/hello.txt");
      expect(entries[0]?.type).toBe("file");
      expect(entries[0]?.size).toBe(content.length);
      expect(entries[0]?.bytes.equals(content)).toBe(true);

      expect(reported).toEqual([
        {
          path: "home/hello.txt",
          bytes: content.length,
          sha256: createHash("sha256").update(content).digest("hex"),
        },
      ]);
    } finally {
      dir.cleanup();
    }
  });

  test("multiple files keep archive order and independent digests", async () => {
    const dir = new TestDirectory();
    try {
      const payloads = [
        { path: "home/a.json", body: Buffer.from('{"a":1}') },
        { path: "home/nested/b.txt", body: Buffer.from("b".repeat(700)) },
        {
          path: "local-backend/agents/x.bin",
          body: Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256)),
        },
      ];
      const { file, reported } = await pack(
        dir,
        "many.hryk",
        payloads.map((item) => ({
          path: item.path,
          type: "file" as const,
          content: item.body,
        })),
      );

      const entries = await unpack(file);
      expect(entries.map((entry) => entry.path)).toEqual(
        payloads.map((item) => item.path),
      );
      for (const [index, payload] of payloads.entries()) {
        expect(entries[index]?.bytes.equals(payload.body)).toBe(true);
        expect(reported[index]?.sha256).toBe(
          createHash("sha256").update(payload.body).digest("hex"),
        );
        expect(reported[index]?.bytes).toBe(payload.body.length);
      }
    } finally {
      dir.cleanup();
    }
  });

  test("empty file round-trips as a zero-length body", async () => {
    const dir = new TestDirectory();
    try {
      const { file, reported } = await pack(dir, "empty-file.hryk", [
        { path: "home/empty.txt", type: "file", content: Buffer.alloc(0) },
      ]);

      const entries = await unpack(file);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.size).toBe(0);
      expect(entries[0]?.bytes.length).toBe(0);
      expect(reported[0]?.bytes).toBe(0);
      expect(reported[0]?.sha256).toBe(
        createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
      );
    } finally {
      dir.cleanup();
    }
  });

  test("reads file bodies from absolutePath and hashes them", async () => {
    const dir = new TestDirectory();
    try {
      const body = Buffer.from("source file contents\r\nsecond line");
      const source = dir.createBinaryFile("src/data.txt", body);
      const { file, reported } = await pack(dir, "from-disk.hryk", [
        { path: "home/data.txt", type: "file", absolutePath: source },
      ]);

      const entries = await unpack(file);
      expect(entries[0]?.bytes.equals(body)).toBe(true);
      expect(reported[0]?.sha256).toBe(
        createHash("sha256").update(body).digest("hex"),
      );
    } finally {
      dir.cleanup();
    }
  });

  test("empty archive round-trips and is a valid gzip file", async () => {
    const dir = new TestDirectory();
    try {
      const { file } = await pack(dir, "empty.hryk", []);
      const gzipped = readFileSync(file);
      expect(gzipped.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
      expect(await unpack(file)).toEqual([]);
      // Two zero blocks: a reader unaware of gzip would still see a valid end.
      const raw = gunzipSync(gzipped);
      expect(raw.length).toBe(1024);
      expect([...raw].every((byte) => byte === 0)).toBe(true);
    } finally {
      dir.cleanup();
    }
  });

  test("CRLF and mixed line endings survive byte for byte", async () => {
    const dir = new TestDirectory();
    try {
      const content = Buffer.from("a\r\nb\nc\r\nd\re\r\n\r\n");
      const { file, reported } = await pack(dir, "crlf.hryk", [
        { path: "home/transcript.jsonl", type: "file", content },
      ]);

      const entries = await unpack(file);
      expect(entries[0]?.bytes.equals(content)).toBe(true);
      expect(entries[0]?.bytes.toString("latin1")).toBe(
        "a\r\nb\nc\r\nd\re\r\n\r\n",
      );
      expect(reported[0]?.sha256).toBe(
        createHash("sha256").update(content).digest("hex"),
      );
    } finally {
      dir.cleanup();
    }
  });
  test("the same entries produce byte-identical packages", async () => {
    const dir = new TestDirectory();
    try {
      const entries: TarEntryInput[] = [
        { path: "home", type: "dir" },
        { path: "home/a.txt", type: "file", content: Buffer.from("stable\n") },
      ];
      const first = await pack(dir, "run-1.hryk", entries);
      const second = await pack(dir, "run-2.hryk", entries);
      // Fixed mode/uid/mtime and gzip without a timestamp make the package
      // reproducible, so a re-export can be compared byte for byte.
      expect(readFileSync(first.file).equals(readFileSync(second.file))).toBe(
        true,
      );
    } finally {
      dir.cleanup();
    }
  });
});

describe("caller callback failures", () => {
  test("a write-side onEntry error surfaces unchanged", async () => {
    const dir = new TestDirectory();
    try {
      const failure = new Error("manifest ledger rejected the entry");
      const work = writeTarGz({
        entries: makeEntries([
          { path: "home/a.txt", type: "file", content: Buffer.from("a") },
        ]),
        outFile: dir.resolve("callback-write.hryk"),
        onEntry: () => {
          throw failure;
        },
      });
      await expect(work).rejects.toBe(failure);
    } finally {
      dir.cleanup();
    }
  });

  test("a read-side onEntry error surfaces unchanged", async () => {
    const dir = new TestDirectory();
    try {
      const failure = new Error("import rejected the entry");
      const { file } = await pack(dir, "callback-read.hryk", [
        { path: "home/a.txt", type: "file", content: Buffer.from("a") },
      ]);
      const work = readTarGz({
        file,
        onEntry: async () => {
          throw failure;
        },
      });
      await expect(work).rejects.toBe(failure);
    } finally {
      dir.cleanup();
    }
  });
});

describe("directory entries", () => {
  test("empty directories round-trip and keep their entry", async () => {
    const dir = new TestDirectory();
    try {
      const { file, reported } = await pack(dir, "dirs.hryk", [
        { path: "home", type: "dir" },
        { path: "home/empty", type: "dir" },
        { path: "home/empty/deeper", type: "dir" },
        // A trailing slash from the caller is tolerated and normalised away.
        { path: "home/with-slash/", type: "dir" },
        { path: "home/file.txt", type: "file", content: Buffer.from("x") },
      ]);

      // Directories are reported too, without a trailing slash and with the
      // empty-string digest, so manifest entries and tar entries pair up.
      const emptyDigest = createHash("sha256")
        .update(Buffer.alloc(0))
        .digest("hex");
      expect(reported.map((entry) => entry.path)).toEqual([
        "home",
        "home/empty",
        "home/empty/deeper",
        "home/with-slash",
        "home/file.txt",
      ]);
      for (const entry of reported.slice(0, 4)) {
        expect(entry.bytes).toBe(0);
        expect(entry.sha256).toBe(emptyDigest);
      }

      const entries = await unpack(file);
      expect(entries.map((entry) => [entry.path, entry.type])).toEqual([
        ["home", "dir"],
        ["home/empty", "dir"],
        ["home/empty/deeper", "dir"],
        ["home/with-slash", "dir"],
        ["home/file.txt", "file"],
      ]);

      // The ustar header carries the trailing slash, which is what tells other
      // tar implementations this is a directory.
      const raw = gunzipSync(readFileSync(file));
      expect(textField(raw.subarray(0, BLOCK), 0, 100)).toBe("home/");
      expect(String.fromCharCode(raw.readUInt8(156))).toBe("5");
      // Every directory name ends with exactly one slash, never two.
      expect(raw.includes(Buffer.from("home/with-slash//", "utf8"))).toBe(
        false,
      );
    } finally {
      dir.cleanup();
    }
  });
});

describe("ustar header fields", () => {
  test("file header uses the fixed metadata values", () => {
    const [block] = encodeTarHeader({
      path: "home/settings.json",
      type: "file",
      size: 42,
    });
    expect(block).toBeDefined();
    if (!block) {
      throw new Error("no header produced");
    }

    expect(textField(block, 0, 100)).toBe("home/settings.json");
    expect(octalField(block, 100, 8)).toBe(0o644);
    expect(octalField(block, 108, 8)).toBe(0);
    expect(octalField(block, 116, 8)).toBe(0);
    expect(octalField(block, 124, 12)).toBe(42);
    expect(octalField(block, 136, 12)).toBe(0);
    expect(String.fromCharCode(block.readUInt8(156))).toBe("0");

    // uname and gname stay empty, so nothing about the source machine leaks.
    expect(octalField(block, 265, 32)).toBe(0);
    expect(octalField(block, 297, 32)).toBe(0);
    expect(textField(block, 265, 32)).toBe("");
    expect(textField(block, 297, 32)).toBe("");

    expect(block.subarray(257, 262).toString("ascii")).toBe("ustar");
    expect(block.readUInt8(262)).toBe(0);
    expect(block.subarray(263, 265).toString("ascii")).toBe("00");

    expect(storedChecksum(block)).toBe(computeChecksum(block));
    expect(block.readUInt8(154)).toBe(0);
    expect(block.readUInt8(155)).toBe(0x20);
  });

  test("directory header uses 0755 and a trailing slash", () => {
    const [block] = encodeTarHeader({ path: "home/empty", type: "dir" });
    expect(block).toBeDefined();
    if (!block) {
      throw new Error("no header produced");
    }
    expect(textField(block, 0, 100)).toBe("home/empty/");
    expect(octalField(block, 100, 8)).toBe(0o755);
    expect(String.fromCharCode(block.readUInt8(156))).toBe("5");
    expect(octalField(block, 124, 12)).toBe(0);
    expect(storedChecksum(block)).toBe(computeChecksum(block));
  });

  test("size at the octal ceiling stays in the ustar header", () => {
    const ceiling = 0o77777777777; // 8589934591, the 8 GiB minus 1 limit
    const blocks = encodeTarHeader({
      path: "big.bin",
      type: "file",
      size: ceiling,
    });
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    expect(block).toBeDefined();
    if (!block) {
      throw new Error("no header produced");
    }
    expect(textField(block, 124, 12)).toBe("77777777777");
    expect(storedChecksum(block)).toBe(computeChecksum(block));
  });

  test("size above 8 GiB minus 1 moves to a PAX record", () => {
    const oversized = 8 * 1024 ** 3; // 8589934592
    const blocks = encodeTarHeader({
      path: "big.bin",
      type: "file",
      size: oversized,
    });
    expect(blocks).toHaveLength(3);

    const [paxHeader, paxBody, entryHeader] = blocks;
    if (!paxHeader || !paxBody || !entryHeader) {
      throw new Error("missing PAX blocks");
    }
    expect(String.fromCharCode(paxHeader.readUInt8(156))).toBe("x");
    expect(storedChecksum(paxHeader)).toBe(computeChecksum(paxHeader));

    const record = paxBody.toString("utf8");
    const match = /^(\d+) size=(\d+)\n/.exec(record);
    expect(match?.[2]).toBe(String(oversized));
    // The length prefix counts itself; the header's size field carries the
    // unpadded record length while the body block is padded to 512 bytes.
    const declared = Number.parseInt(match?.[1] ?? "", 10);
    expect(declared).toBe(Buffer.byteLength(match?.[0] ?? "", "utf8"));
    expect(octalField(paxHeader, 124, 12)).toBe(declared);
    expect(paxBody.length).toBe(BLOCK);

    // The ustar header cannot express the size; a PAX-aware reader takes it
    // from the record above, and the field stays 0 rather than a truncated
    // number that a fallback reader would trust.
    expect(String.fromCharCode(entryHeader.readUInt8(156))).toBe("0");
    expect(octalField(entryHeader, 124, 12)).toBe(0);
    expect(textField(entryHeader, 124, 12)).toBe("00000000000");
    expect(storedChecksum(entryHeader)).toBe(computeChecksum(entryHeader));
  });
});

describe("PAX long paths", () => {
  test("path over 100 bytes with Chinese and spaces round-trips", async () => {
    const dir = new TestDirectory();
    try {
      const longPath = `home/记忆 库/${"会话 记录/".repeat(6)}最终 导出.jsonl`;
      expect(Buffer.byteLength(longPath, "utf8")).toBeGreaterThan(100);

      const content = Buffer.from(`{"role":"user","text":"你好"}\r\n`);
      const { file } = await pack(dir, "long-path.hryk", [
        { path: longPath, type: "file", content },
      ]);

      const entries = await unpack(file);
      expect(entries[0]?.path).toBe(longPath);
      expect(entries[0]?.bytes.equals(content)).toBe(true);

      // The raw tar carries a PAX `path=` record; the ustar name is a truncated
      // prefix, so only a PAX-aware reader can recover the full name.
      const raw = gunzipSync(readFileSync(file));
      const header = raw.subarray(0, BLOCK);
      expect(String.fromCharCode(header.readUInt8(156))).toBe("x");
      const paxSize = octalField(header, 124, 12);
      const paxBody = raw.subarray(BLOCK, BLOCK + paxSize).toString("utf8");
      expect(paxBody).toContain(`path=${longPath}\n`);
      expect(storedChecksum(header)).toBe(computeChecksum(header));
    } finally {
      dir.cleanup();
    }
  });

  test("path of exactly 100 bytes stays in the ustar header", () => {
    const path = "a".repeat(100);
    const blocks = encodeTarHeader({ path, type: "file", size: 1 });
    expect(blocks).toHaveLength(1);
    expect(textField(blocks[0] ?? Buffer.alloc(0), 0, 100)).toBe(path);
  });

  test("101-byte path moves to PAX and truncation keeps UTF-8 intact", async () => {
    const dir = new TestDirectory();
    try {
      // Multibyte at the 100-byte boundary: the truncated ustar name must not
      // end with half a code point.
      const path = `${"界".repeat(40)}/file.txt`; // 120 bytes before the suffix
      const blocks = encodeTarHeader({ path, type: "file", size: 0 });
      expect(blocks).toHaveLength(3);
      const headerName = textField(blocks[2] ?? Buffer.alloc(0), 0, 100);
      expect(headerName.length).toBeGreaterThan(0);
      expect(() => JSON.stringify(headerName)).not.toThrow();
      expect(headerName).not.toContain("\uFFFD");
    } finally {
      dir.cleanup();
    }
  });
});

describe("reader rejection", () => {
  test("absolute path is refused with path_conflict", async () => {
    const dir = new TestDirectory();
    try {
      const file = writeRawPackage(
        dir,
        "absolute.hryk",
        rawTar([{ path: "/etc/passwd", type: "file" }]),
      );
      await expectCode(unpack(file), "path_conflict");
    } finally {
      dir.cleanup();
    }
  });

  test("drive letter is refused with path_conflict", async () => {
    const dir = new TestDirectory();
    try {
      const file = writeRawPackage(
        dir,
        "drive.hryk",
        rawTar([{ path: "C:/Users/x/.haruyuki", type: "file" }]),
      );
      await expectCode(unpack(file), "path_conflict");
    } finally {
      dir.cleanup();
    }
  });

  test("parent traversal is refused with path_conflict", async () => {
    const dir = new TestDirectory();
    try {
      const file = writeRawPackage(
        dir,
        "traversal.hryk",
        rawTar([{ path: "home/../../escape.txt", type: "file" }]),
      );
      await expectCode(unpack(file), "path_conflict");

      const windows = writeRawPackage(
        dir,
        "traversal-backslash.hryk",
        rawTar([{ path: "home\\..\\..\\escape.txt", type: "file" }]),
      );
      await expectCode(unpack(windows), "path_conflict");
    } finally {
      dir.cleanup();
    }
  });

  test("symlink typeflag is refused instead of followed", async () => {
    const dir = new TestDirectory();
    try {
      const tar = rawTar([
        { path: "home/link", type: "file", content: Buffer.from("target") },
      ]);
      // Turn the first entry into a symlink ('2') without touching the rest.
      tar.write("2", 156, 1, "ascii");
      const file = writeRawPackage(dir, "symlink.hryk", tar);
      await expectCode(unpack(file), "path_conflict");
    } finally {
      dir.cleanup();
    }
  });

  test("missing end-of-archive blocks raise verify_failed", async () => {
    const dir = new TestDirectory();
    try {
      const noEnd = writeRawPackage(
        dir,
        "no-end.hryk",
        rawTar(
          [{ path: "home/a.txt", type: "file", content: Buffer.from("a") }],
          {
            endBlocks: 0,
          },
        ),
      );
      await expectCode(unpack(noEnd), "verify_failed");

      const oneEnd = writeRawPackage(
        dir,
        "one-end.hryk",
        rawTar(
          [{ path: "home/a.txt", type: "file", content: Buffer.from("a") }],
          { endBlocks: 1 },
        ),
      );
      await expectCode(unpack(oneEnd), "verify_failed");
    } finally {
      dir.cleanup();
    }
  });

  test("a body shorter than its declared size raises verify_failed", async () => {
    const dir = new TestDirectory();
    try {
      const tar = rawTar([
        { path: "home/a.txt", type: "file", content: Buffer.from("abc") },
      ]);
      // Claim 4096 bytes but keep only the 512-wide block that follows.
      tar.write("00000007777", 124, 11, "ascii");
      const file = writeRawPackage(dir, "short.hryk", tar);
      await expectCode(unpack(file), "verify_failed");
    } finally {
      dir.cleanup();
    }
  });
});

describe("system tar cross-check", () => {
  const tar = SYSTEM_TAR;

  test.skipIf(tar === undefined)("bsdtar lists the package", async () => {
    const dir = new TestDirectory();
    try {
      // An ASCII path over 100 bytes exercises the PAX `path` record through
      // bsdtar's own listing. The listing is asserted byte-wise because this
      // bsdtar prints names in the host ANSI code page, which mangles
      // non-ASCII names on the way out (the extract test below covers those).
      const longPath = `home/long ${"segment ".repeat(11)}name.txt`;
      expect(Buffer.byteLength(longPath, "utf8")).toBeGreaterThan(100);
      const { file } = await pack(dir, "cross.hryk", [
        { path: "home", type: "dir" },
        { path: "home/empty", type: "dir" },
        {
          path: "home/settings.json",
          type: "file",
          content: Buffer.from("{}"),
        },
        { path: longPath, type: "file", content: Buffer.from("hi\r\n") },
      ]);

      const result = Bun.spawnSync(["tar", "-tvf", file], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = result.stdout.toString("utf8");
      expect(result.exitCode).toBe(0);
      expect(result.stderr.toString("utf8")).toBe("");
      expect(stdout).toContain("home/settings.json");
      expect(stdout).toContain("drwxr-xr-x");
      expect(stdout).toContain("-rw-r--r--");
      // mtime 0 renders as the epoch regardless of the local time zone.
      expect(stdout).toContain("1970");
      // Four entries: two directories and two files.
      expect(stdout.trim().split(/\r?\n/)).toHaveLength(4);
      // The full PAX path, not a truncated ustar prefix.
      expect(result.stdout.includes(Buffer.from(longPath, "utf8"))).toBe(true);
    } finally {
      dir.cleanup();
    }
  });

  test.skipIf(tar === undefined)("bsdtar extracts the same bytes", async () => {
    const dir = new TestDirectory();
    try {
      const content = Buffer.from("alpha\r\nbeta\r\n");
      const longUnicodePath = `home/记忆 库/${"会话 记录/".repeat(6)}最终 导出.jsonl`;
      const unicodeBody = Buffer.from("你好\r\n");
      const { file } = await pack(dir, "extract.hryk", [
        { path: "home/x.txt", type: "file", content },
        {
          path: longUnicodePath,
          type: "file",
          content: unicodeBody,
        },
      ]);
      const out = dir.createDir("out");
      const result = Bun.spawnSync(["tar", "-xf", file, "-C", out], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      expect(result.stderr.toString("utf8")).toBe("");
      expect(readFileSync(dir.resolve("out/home/x.txt")).equals(content)).toBe(
        true,
      );
      // Extraction goes through wide-char APIs, so the PAX name and its bytes
      // survive even though the listing text does not.
      expect(
        readFileSync(dir.resolve(`out/${longUnicodePath}`)).equals(unicodeBody),
      ).toBe(true);
    } finally {
      dir.cleanup();
    }
  });
});
