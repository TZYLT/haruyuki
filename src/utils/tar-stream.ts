/**
 * tar.gz codec for Haruyuki snapshot packages (`.hryk`).
 *
 * The repository has no tar implementation and adding a dependency is off the
 * table (docs/44-2 section 5.2.1), so this module writes and reads the archive
 * format itself. It is a pure codec: no snapshot knowledge, no scope rules, no
 * manifest. Callers stream entries in and out through the two exported
 * functions; everything the package needs beyond that (atomic `.partial`
 * rename, manifest hashes, secrets) lives in the snapshot pipeline.
 *
 * Format decisions, all of them about reproducibility and cross-tool
 * compatibility (docs/45-2 section 2.3):
 *
 * - ustar blocks of 512 bytes; typeflag `0` for files, `5` for directories.
 * - directory entries are always written, with a trailing slash in the name,
 *   because an empty directory exists only as its own entry.
 * - fixed metadata: mode 0644 for files, 0755 for directories, uid/gid 0,
 *   empty uname/gname, mtime 0. Nothing about the source machine leaks into
 *   the package and the same input always produces the same archive.
 * - `name` longer than 100 bytes, or a size above the 11-digit octal ceiling
 *   (8 GiB minus 1), moves to a PAX extended header (`path=` / `size=`). The
 *   PAX header is a normal entry with typeflag `x` that precedes the entry it
 *   describes.
 * - the archive ends with two 1024-byte zero blocks; the reader refuses an
 *   archive that does not carry them, which is how a truncated package is
 *   detected.
 * - symbolic links are never written. Following them is the exporter's job
 *   (it resolves the link and passes `absolutePath`), so a link cannot smuggle
 *   an absolute path into the package.
 *
 * gzip is `node:zlib` at level 6. Both directions are streaming: the writer
 * never buffers a whole entry beyond one chunk, the reader hands each entry to
 * the caller as a `Readable` over the live gunzip stream. A file's SHA-256 is
 * computed during the write pass, so hashing costs no second read.
 *
 * Errors carry a `code` field (`TarStreamError`) so callers map them onto the
 * snapshot error taxonomy without matching message text.
 *
 * Known limitation: the reader does not validate the ustar header checksum.
 * Content integrity is enforced by the end-of-archive marker plus the
 * manifest's per-entry SHA-256, and a checksum rejection would add a failure
 * path the requirement does not ask for (recorded in docs/46-2 §1.8).
 */

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, statSync } from "node:fs";
import { pipeline, Readable } from "node:stream";
import { createGunzip, createGzip } from "node:zlib";

/** Size of one tar block. */
const BLOCK = 512;

/** The two zero blocks that terminate an archive. */
const END_BYTES = 1024;

/** Largest size an 11-digit octal `size` field can hold: 8 GiB minus 1. */
const MAX_USTAR_SIZE = 0o77777777777;

/** Chunk size for streaming entry bodies. */
const DATA_CHUNK = 64 * 1024;

/**
 * SHA-256 of the empty byte string. Directory entries have no body, so this is
 * what `onEntry` reports for them (the value is the same one the manifest
 * computes for a zero-byte file, which keeps the two lists comparable).
 */
const EMPTY_SHA256 = createHash("sha256").update(Buffer.alloc(0)).digest("hex");

/** Offset of each ustar header field inside its 512-byte block. */
const FIELD = {
  name: 0,
  mode: 100,
  uid: 108,
  gid: 116,
  size: 124,
  mtime: 136,
  checksum: 148,
  typeflag: 156,
  linkname: 157,
  magic: 257,
  version: 263,
  uname: 265,
  gname: 297,
  devmajor: 329,
  devminor: 337,
  prefix: 345,
} as const;

/**
 * Failure classes this codec can raise. They are a subset of the snapshot
 * `SnapshotErrorCode` union so the pipeline can rethrow them unchanged:
 *
 * - `path_conflict`: the archive names something that must never be unpacked
 *   (absolute path, drive letter, `..` traversal, symlink or other unsupported
 *   typeflag) or an entry the caller asked to write is unusable.
 * - `verify_failed`: the archive is truncated or corrupt (missing end blocks,
 *   short block, bad octal field, body shorter than its declared size).
 * - `io_error`: the underlying file could not be read or written.
 */
export type TarStreamErrorCode = "path_conflict" | "verify_failed" | "io_error";

/** Error raised by this codec; branch on `code`, never on `message`. */
export class TarStreamError extends Error {
  public readonly code: TarStreamErrorCode;

  constructor(code: TarStreamErrorCode, message: string) {
    super(message);
    this.name = "TarStreamError";
    this.code = code;
  }
}

/** One entry the caller wants packed. */
export interface TarEntryInput {
  /** Package-relative path, `/`-separated, no drive letter and no `..`. */
  path: string;
  type: "file" | "dir";
  /** Source file to stream. Ignored for directories and when `content` is set. */
  absolutePath?: string;
  /** In-memory body. Takes precedence over `absolutePath`. */
  content?: Buffer;
}

/** Per-file summary reported while the archive is written. */
export interface TarEntryDigest {
  path: string;
  bytes: number;
  sha256: string;
}

/** Fields needed to encode one ustar header (and its optional PAX block). */
export interface TarHeaderInput {
  path: string;
  type: "file" | "dir";
  /** Declared body size in bytes. Defaults to 0. */
  size?: number;
}

/** One entry handed to the reader's `onEntry` callback. */
export interface TarReadEntry {
  path: string;
  type: "file" | "dir";
  size: number;
  /**
   * Body stream, limited to exactly `size` bytes. Consume it inside the
   * callback (the reader drains whatever is left afterwards); call it at most
   * once.
   */
  open: () => Readable;
}

/** True when `error` is a codec error, for callers that map error codes. */
export function isTarStreamError(error: unknown): error is TarStreamError {
  return error instanceof TarStreamError;
}

/**
 * Encode the header blocks for one entry: the optional PAX extended header and
 * its body, followed by the ustar block. Returns 512-byte buffers that the
 * writer emits as-is, which is why the tests can assert on exact header bytes
 * (including the oversized-size path) without writing an 8 GiB file.
 * @internal Exported for the oversized-size header assertion and the writer
 * itself; the package surface is `writeTarGz` / `readTarGz` plus the error type.
 */
export function encodeTarHeader(input: TarHeaderInput): Buffer[] {
  const size = input.size ?? 0;
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new TarStreamError(
      "path_conflict",
      `invalid size for entry ${input.path}`,
    );
  }

  const name = entryName(input.path, input.type);
  const typeflag = input.type === "dir" ? "5" : "0";
  const mode = input.type === "dir" ? 0o755 : 0o644;

  const records: Array<readonly [string, string]> = [];
  if (Buffer.byteLength(name, "utf8") > 100) {
    records.push(["path", name]);
  }
  const oversized = size > MAX_USTAR_SIZE;
  if (oversized) {
    records.push(["size", String(size)]);
  }

  const blocks: Buffer[] = [];
  if (records.length > 0) {
    const body = encodePaxRecords(records);
    blocks.push(
      buildBlock({
        name: truncateUtf8(`PaxHeaders/${basename(name)}`, 100),
        mode: 0o644,
        size: body.length,
        typeflag: "x",
      }),
    );
    blocks.push(padToBlock(body));
  }
  blocks.push(
    buildBlock({
      name,
      mode,
      // A PAX `size` record overrides this field; write 0 rather than a
      // truncated number so a PAX-aware reader and a fallback reader agree
      // that the size is not knowable from the ustar header.
      size: oversized ? 0 : size,
      typeflag,
    }),
  );
  return blocks;
}

/**
 * Write `entries` as a gzipped tar to `outFile`.
 *
 * The caller owns the output path: it should pass the `.partial` name and
 * rename on success (docs/44-2 section 5.2.7). On any failure the stream is
 * torn down and the file is left partial for the caller to delete.
 *
 * `onEntry` fires once per entry, after its body has been written, with the
 * byte count and SHA-256 computed during that same write pass. Directories are
 * reported too, as `bytes: 0` with the SHA-256 of the empty byte string and a
 * path without a trailing slash, so the archive ledger lines up one-to-one with
 * the manifest.
 */
export async function writeTarGz(opts: {
  entries: AsyncIterable<TarEntryInput>;
  outFile: string;
  onEntry?: (entry: TarEntryDigest) => void;
}): Promise<void> {
  const source = Readable.from(writeBlocks(opts.entries, opts.onEntry));
  const gzip = createGzip({ level: 6 });
  const sink = createWriteStream(opts.outFile);

  try {
    await new Promise<void>((resolve, reject) => {
      pipeline(source, gzip, sink, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  } catch (error) {
    if (error instanceof CallerFailure) {
      throw error.inner;
    }
    throw toTarStreamError(error, "io_error");
  }
}

/**
 * Read a gzipped tar, calling `onEntry` for every entry in archive order.
 *
 * Paths are validated before the callback sees them: an absolute path, a drive
 * letter, a `..` traversal segment or a typeflag other than `0`/`5` raises
 * `path_conflict`, so a hostile package cannot talk the importer into writing
 * outside the target root. A missing end-of-archive marker raises
 * `verify_failed`.
 *
 * `entry.open()` is single-use: consume it inside the callback before
 * returning. The reader drains any remainder afterwards, so holding the handle
 * across entries or opening it twice corrupts the stream position.
 */
export async function readTarGz(opts: {
  file: string;
  onEntry: (entry: TarReadEntry) => Promise<void>;
}): Promise<void> {
  const gunzip = createGunzip();
  const input = createReadStream(opts.file);
  // `pipe` would leave a read error stranded on the source stream and hang the
  // block reader; `pipeline` destroys the gunzip stream with the same error,
  // which surfaces through the async iterator below.
  pipeline(input, gunzip, () => undefined);

  const bytes = new ByteReader(gunzip);

  try {
    let pax: Map<string, string> | undefined;
    let ended = false;

    for (;;) {
      const block = await bytes.readBlock();
      if (!block) {
        break;
      }
      if (isZeroBlock(block)) {
        const second = await bytes.readBlock();
        if (!second || !isZeroBlock(second)) {
          throw new TarStreamError(
            "verify_failed",
            `${opts.file}: archive ends after one zero block`,
          );
        }
        ended = true;
        break;
      }

      const typeflag = String.fromCharCode(block.readUInt8(FIELD.typeflag));

      if (typeflag === "x" || typeflag === "g") {
        const body = await bytes.readExactly(
          readOctal(block, FIELD.size, 12, opts.file),
        );
        await bytes.skip(padding(body.length));
        const records = parsePaxRecords(body, opts.file);
        // A per-file extended header applies to the next entry only; a global
        // one is consumed and ignored (packages written here never emit `g`,
        // but refusing one would reject archives other tools produce).
        if (typeflag === "x") {
          pax = records;
        }
        continue;
      }

      const overrides = pax;
      pax = undefined;

      const headerName = overrides?.get("path") ?? readHeaderName(block);
      const headerSize = readOctal(block, FIELD.size, 12, opts.file);
      const paxSize = overrides?.get("size");
      const size =
        paxSize === undefined
          ? headerSize
          : parseDecimalSize(paxSize, opts.file, headerName);

      let type: "file" | "dir";
      if (typeflag === "0") {
        type = "file";
      } else if (typeflag === "5") {
        type = "dir";
      } else {
        throw new TarStreamError(
          "path_conflict",
          `${opts.file}: entry ${headerName} has unsupported typeflag ${JSON.stringify(typeflag)}`,
        );
      }

      const path = validateEntryPath(headerName, type, opts.file);

      let left = size;
      const open = (): Readable =>
        Readable.from(
          (async function* streamEntry() {
            while (left > 0) {
              const chunk = await bytes.readUpTo(Math.min(left, DATA_CHUNK));
              if (!chunk) {
                throw new TarStreamError(
                  "verify_failed",
                  `${opts.file}: entry ${path} is shorter than its declared size`,
                );
              }
              left -= chunk.length;
              yield chunk;
            }
          })(),
        );

      await callOnEntry(opts.onEntry, { path, type, size, open });

      // The callback may not have consumed the body; drain the remainder so
      // the next header starts at a block boundary.
      while (left > 0) {
        const chunk = await bytes.readUpTo(Math.min(left, DATA_CHUNK));
        if (!chunk) {
          throw new TarStreamError(
            "verify_failed",
            `${opts.file}: entry ${path} is shorter than its declared size`,
          );
        }
        left -= chunk.length;
      }
      await bytes.skip(padding(size));
    }

    if (!ended) {
      throw new TarStreamError(
        "verify_failed",
        `${opts.file}: missing end-of-archive marker`,
      );
    }
  } catch (error) {
    if (error instanceof CallerFailure) {
      throw error.inner;
    }
    throw toTarStreamError(error, "verify_failed");
  } finally {
    gunzip.destroy();
    input.destroy();
  }
}

/**
 * Producer for `writeTarGz`: yields header blocks and entry bodies, then the
 * two zero blocks.
 */
async function* writeBlocks(
  entries: AsyncIterable<TarEntryInput>,
  onEntry: ((entry: TarEntryDigest) => void) | undefined,
): AsyncGenerator<Buffer> {
  for await (const entry of entries) {
    // Callers pass directory paths without a trailing slash; tolerate one that
    // slipped through so the header and the reported path stay canonical.
    const path =
      entry.type === "dir" ? entry.path.replace(/\/+$/, "") : entry.path;
    const size = entry.type === "dir" ? 0 : declareSize(entry);
    for (const block of encodeTarHeader({
      path,
      type: entry.type,
      size,
    })) {
      yield block;
    }
    if (entry.type === "dir") {
      onEntry?.({ path, bytes: 0, sha256: EMPTY_SHA256 });
      continue;
    }

    const hash = createHash("sha256");
    let written = 0;
    for await (const chunk of entryChunks(entry)) {
      hash.update(chunk);
      written += chunk.length;
      yield chunk;
    }
    if (written !== size) {
      throw new TarStreamError(
        "io_error",
        `${path}: expected ${size} bytes but read ${written}`,
      );
    }
    const pad = padding(size);
    if (pad > 0) {
      yield Buffer.alloc(pad);
    }
    if (onEntry) {
      callOnEntrySync(onEntry, {
        path,
        bytes: written,
        sha256: hash.digest("hex"),
      });
    }
  }
  yield Buffer.alloc(END_BYTES);
}

/** Body size of a file entry, taken from memory or from the source file. */
function declareSize(entry: TarEntryInput): number {
  if (entry.content) {
    return entry.content.length;
  }
  if (!entry.absolutePath) {
    throw new TarStreamError(
      "io_error",
      `${entry.path}: entry has neither content nor absolutePath`,
    );
  }
  try {
    return statSync(entry.absolutePath).size;
  } catch (error) {
    throw toTarStreamError(error, "io_error");
  }
}

/** Yield the body of a file entry. */
async function* entryChunks(entry: TarEntryInput): AsyncGenerator<Buffer> {
  if (entry.content) {
    if (entry.content.length > 0) {
      yield entry.content;
    }
    return;
  }
  const source = entry.absolutePath;
  if (!source) {
    return;
  }
  const stream = createReadStream(source);
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      yield chunk;
    }
  } finally {
    stream.destroy();
  }
}

/** Offset-safe reader over the gunzip stream with a small carry buffer. */
class ByteReader {
  private readonly iterator: AsyncIterator<Buffer>;
  private buffered: Buffer = Buffer.alloc(0);
  private exhausted = false;

  constructor(stream: Readable) {
    this.iterator = (stream as AsyncIterable<Buffer>)[Symbol.asyncIterator]();
  }

  private async pull(): Promise<boolean> {
    if (this.exhausted) {
      return false;
    }
    const next = await this.iterator.next();
    if (next.done) {
      this.exhausted = true;
      return false;
    }
    const chunk = next.value;
    this.buffered =
      this.buffered.length === 0
        ? chunk
        : Buffer.concat([this.buffered, chunk]);
    return true;
  }

  /** Read exactly `length` bytes, or raise `verify_failed` at end of stream. */
  async readExactly(length: number): Promise<Buffer> {
    while (this.buffered.length < length) {
      if (!(await this.pull())) {
        throw new TarStreamError(
          "verify_failed",
          `archive is truncated: wanted ${length} bytes`,
        );
      }
    }
    const out = this.buffered.subarray(0, length);
    this.buffered = this.buffered.subarray(length);
    return out;
  }

  /**
   * Read one 512-byte block, or `undefined` when the stream ends cleanly on a
   * block boundary.
   */
  async readBlock(): Promise<Buffer | undefined> {
    if (this.buffered.length === 0 && !(await this.pull())) {
      return undefined;
    }
    while (this.buffered.length < BLOCK) {
      if (!(await this.pull())) {
        throw new TarStreamError(
          "verify_failed",
          "archive is truncated: partial header block",
        );
      }
    }
    const block = this.buffered.subarray(0, BLOCK);
    this.buffered = this.buffered.subarray(BLOCK);
    return block;
  }

  /** Read up to `max` bytes without waiting for more than one chunk. */
  async readUpTo(max: number): Promise<Buffer | undefined> {
    if (this.buffered.length === 0 && !(await this.pull())) {
      return undefined;
    }
    const take = Math.min(max, this.buffered.length);
    const out = this.buffered.subarray(0, take);
    this.buffered = this.buffered.subarray(take);
    return out;
  }

  /** Discard `length` bytes (block padding). */
  async skip(length: number): Promise<void> {
    if (length > 0) {
      await this.readExactly(length);
    }
  }
}

/** Build one 512-byte ustar header with a valid checksum. */
function buildBlock(fields: {
  name: string;
  mode: number;
  size: number;
  typeflag: string;
}): Buffer {
  const block = Buffer.alloc(BLOCK);
  writeText(block, FIELD.name, 100, truncateUtf8(fields.name, 100));
  writeOctal(block, FIELD.mode, 8, fields.mode);
  writeOctal(block, FIELD.uid, 8, 0);
  writeOctal(block, FIELD.gid, 8, 0);
  writeOctal(block, FIELD.size, 12, fields.size);
  writeOctal(block, FIELD.mtime, 12, 0);
  block.fill(0x20, FIELD.checksum, FIELD.checksum + 8);
  writeText(block, FIELD.typeflag, 1, fields.typeflag);
  // linkname, uname, gname, devmajor, devminor and prefix stay NUL.
  writeText(block, FIELD.magic, 5, "ustar");
  writeText(block, FIELD.version, 2, "00");
  writeChecksum(block);
  return block;
}

/** Copy UTF-8 text into a fixed-width field, never overflowing it. */
function writeText(
  block: Buffer,
  offset: number,
  length: number,
  text: string,
): void {
  const source = Buffer.from(text, "utf8");
  source.copy(block, offset, 0, Math.min(source.length, length));
}

/**
 * Write a numeric field as zero-padded octal with a NUL terminator. `length`
 * counts the terminator, matching the ustar field widths.
 */
function writeOctal(
  block: Buffer,
  offset: number,
  length: number,
  value: number,
): void {
  const digits = length - 1;
  const text = Math.max(0, Math.trunc(value))
    .toString(8)
    .padStart(digits, "0")
    .slice(-digits);
  block.write(text, offset, digits, "ascii");
  block.writeUInt8(0, offset + digits);
}

/**
 * Fill in the checksum: the field is read as eight spaces during the sum, then
 * rewritten as six octal digits, a NUL and a space.
 */
function writeChecksum(block: Buffer): void {
  block.fill(0x20, FIELD.checksum, FIELD.checksum + 8);
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    sum += block.readUInt8(index);
  }
  const text = sum.toString(8).padStart(6, "0").slice(-6);
  block.write(text, FIELD.checksum, 6, "ascii");
  block.writeUInt8(0, FIELD.checksum + 6);
  block.writeUInt8(0x20, FIELD.checksum + 7);
}

/** Encode PAX records, each prefixed with its own total byte length. */
function encodePaxRecords(
  records: ReadonlyArray<readonly [string, string]>,
): Buffer {
  let text = "";
  for (const [key, value] of records) {
    const body = ` ${key}=${value}\n`;
    const bodyLength = Buffer.byteLength(body, "utf8");
    let total = bodyLength + 1;
    for (;;) {
      const next = bodyLength + String(total).length;
      if (next === total) {
        break;
      }
      total = next;
    }
    text += `${total}${body}`;
  }
  return Buffer.from(text, "utf8");
}

/** Parse PAX records into a key to value map. */
function parsePaxRecords(block: Buffer, file: string): Map<string, string> {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < block.length) {
    const space = block.indexOf(0x20, offset);
    if (space === -1) {
      throw new TarStreamError(
        "verify_failed",
        `${file}: malformed PAX record header`,
      );
    }
    const length = Number.parseInt(
      block.subarray(offset, space).toString("ascii"),
      10,
    );
    if (!Number.isSafeInteger(length) || length <= 0) {
      throw new TarStreamError(
        "verify_failed",
        `${file}: malformed PAX record length`,
      );
    }
    const end = offset + length;
    if (end > block.length) {
      throw new TarStreamError(
        "verify_failed",
        `${file}: PAX record runs past its header`,
      );
    }
    const record = block.subarray(space + 1, end).toString("utf8");
    const match = /^([A-Za-z0-9._-]+)=(.*)\n$/s.exec(record);
    if (!match) {
      throw new TarStreamError(
        "verify_failed",
        `${file}: malformed PAX record`,
      );
    }
    const key = match[1];
    const value = match[2];
    if (key !== undefined && value !== undefined) {
      records.set(key, value);
    }
    offset = end;
  }
  return records;
}

/** Read a NUL-terminated field as UTF-8. */
function readCString(block: Buffer, offset: number, length: number): string {
  const field = block.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return (end === -1 ? field : field.subarray(0, end)).toString("utf8");
}

/** Rebuild the entry name from `prefix` and `name` (ustar split naming). */
function readHeaderName(block: Buffer): string {
  const name = readCString(block, FIELD.name, 100);
  const prefix = readCString(block, FIELD.prefix, 155);
  return prefix.length > 0 ? `${prefix}/${name}` : name;
}

/** Parse an octal numeric field, tolerating leading and trailing padding. */
function readOctal(
  block: Buffer,
  offset: number,
  length: number,
  file: string,
): number {
  let text = "";
  for (let index = 0; index < length; index += 1) {
    const byte = block.readUInt8(offset + index);
    if (byte === 0 || byte === 0x20) {
      if (text.length > 0) {
        break;
      }
      continue;
    }
    if (byte < 0x30 || byte > 0x37) {
      throw new TarStreamError(
        "verify_failed",
        `${file}: invalid octal field at offset ${offset}`,
      );
    }
    text += String.fromCharCode(byte);
  }
  if (text.length === 0) {
    return 0;
  }
  return Number.parseInt(text, 8);
}

/** Validate a PAX `size` record. */
function parseDecimalSize(value: string, file: string, name: string): number {
  const size = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new TarStreamError(
      "verify_failed",
      `${file}: entry ${name} declares an invalid size`,
    );
  }
  return size;
}

/**
 * Reject anything that would resolve outside the target root, and normalise a
 * directory name back to the shape `TarEntryInput.path` uses (no trailing
 * slash).
 */
function validateEntryPath(
  raw: string,
  type: "file" | "dir",
  file: string,
): string {
  const path = type === "dir" ? raw.replace(/\/+$/, "") : raw;
  const reject = (reason: string): never => {
    throw new TarStreamError(
      "path_conflict",
      `${file}: entry ${JSON.stringify(raw)} ${reason}`,
    );
  };

  if (path.length === 0) {
    return reject("has an empty path");
  }
  if (path.startsWith("/") || path.startsWith("\\")) {
    return reject("is an absolute path");
  }
  if (/^[A-Za-z]:/.test(path)) {
    return reject("has a drive letter");
  }
  for (const segment of path.split(/[\\/]+/)) {
    if (segment === "..") {
      return reject("escapes its root with a parent segment");
    }
  }
  return path;
}

/** The name written into the header: directories carry a trailing slash. */
function entryName(path: string, type: "file" | "dir"): string {
  if (type === "dir" && !path.endsWith("/")) {
    return `${path}/`;
  }
  return path;
}

/** Last path segment, used for the PAX header's own name. */
function basename(name: string): string {
  const trimmed = name.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}

/** Bytes of zero padding needed to round `size` up to a block boundary. */
function padding(size: number): number {
  return (BLOCK - (size % BLOCK)) % BLOCK;
}

/** Pad `content` with zeros to a whole number of blocks. */
function padToBlock(content: Buffer): Buffer {
  const pad = padding(content.length);
  return pad === 0 ? content : Buffer.concat([content, Buffer.alloc(pad)]);
}

/** True when every byte of the block is zero. */
function isZeroBlock(block: Buffer): boolean {
  for (let index = 0; index < block.length; index += 1) {
    if (block.readUInt8(index) !== 0) {
      return false;
    }
  }
  return true;
}

/**
 * Shorten `text` to at most `maxBytes` of UTF-8 without splitting a code
 * point, which would produce an unreadable name.
 */
function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) {
    return text;
  }
  let cut = maxBytes;
  // Byte at `cut` is 10xxxxxx only when a code point straddles the limit; walk
  // back to its leading byte and drop the whole character.
  while (cut > 0 && (bytes.readUInt8(cut) & 0xc0) === 0x80) {
    cut -= 1;
  }
  return bytes.subarray(0, cut).toString("utf8");
}

/**
 * Marks an error thrown by a caller's callback so the codec's catch block can
 * rethrow it untouched. A failed callback is the caller's failure (import or
 * export logic); relabelling it `verify_failed` would send the pipeline down
 * the wrong recovery path and discard the original error.
 */
class CallerFailure extends Error {
  public readonly inner: unknown;

  constructor(inner: unknown) {
    super("caller callback failed");
    this.inner = inner;
  }
}

/** Invoke an async caller callback, tagging its error as a caller failure. */
async function callOnEntry<T>(
  callback: (entry: T) => Promise<void>,
  entry: T,
): Promise<void> {
  try {
    await callback(entry);
  } catch (error) {
    throw new CallerFailure(error);
  }
}

/** Invoke a sync caller callback, tagging its error as a caller failure. */
function callOnEntrySync<T>(callback: (entry: T) => void, entry: T): void {
  try {
    callback(entry);
  } catch (error) {
    throw new CallerFailure(error);
  }
}

/** Normalise any thrown value into a codec error with a stable `code`. */
function toTarStreamError(
  error: unknown,
  fallback: TarStreamErrorCode,
): TarStreamError {
  if (error instanceof TarStreamError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  if (
    typeof code === "string" &&
    [
      "ENOENT",
      "EACCES",
      "EPERM",
      "EBUSY",
      "EISDIR",
      "ENOTDIR",
      "ENOSPC",
    ].includes(code)
  ) {
    return new TarStreamError("io_error", message);
  }
  return new TarStreamError(fallback, message);
}
