/**
 * Zero-dependency tar/gzip extraction for the embedding runtime tarballs.
 *
 * **Why hand-rolled.** The runtime is downloaded from an npm registry at first
 * use (48-1 §6.4), so the package ships no tar dependency (48-2 §5.1: "零新
 * 依赖"). npm tarballs use POSIX ustar headers plus a small PAX/GNU extension
 * subset, which is all this reader supports; every other format is refused
 * rather than guessed.
 *
 * **Why this file is security-sensitive.** The archive is remote data. A tar
 * entry name is attacker-controlled input on the same footing as an HTTP header
 * value: `../`, an absolute path, a Windows drive letter/UNC prefix, an NTFS
 * alternate-data-stream colon, or a NUL byte could redirect a write out of the
 * destination directory (zip-slip). Three independent layers stop that:
 *
 * 1. Entry names are split into segments and each segment is validated; `..`,
 *    empty/`.` segments, colons, absolute names and UNC names are refused.
 * 2. The resolved target is re-checked with `path.relative` so a platform
 *    quirk (drive-relative resolution, separators) cannot escape either.
 * 3. Link entries (`1` hard link, `2` symlink) are refused outright. A link is
 *    how a later benign-looking entry could otherwise escape: resolving it
 *    writes outside the tree without ever containing `..` in an entry name.
 *
 * Only regular files (`0`, NUL, `7`) and directories (`5`) are extracted. The
 * unsigned *and* signed tar header checksum are accepted (both appear in the
 * wild), and a bad checksum stops the archive instead of extracting garbage.
 *
 * **Shape.** Extraction streams from the gzip stream: the tarball is ~115 MB on
 * the wire, so nothing is buffered whole. File data is written chunk by chunk
 * with backpressure, and skipped entries are drained rather than buffered.
 *
 * Layer: `backend/local/`. Imports only `node:` builtins; no domain imports.
 */

import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

/** One 512-byte tar block. */
const BLOCK_SIZE = 512;
const CHECKSUM_OFFSET = 148;
const CHECKSUM_LENGTH = 8;
const DEFAULT_STRIP_DIRECTORY = "package";

/** Why an archive could not be read or extracted. */
export type TarArchiveErrorKind =
  | "checksum"
  | "gzip"
  | "io"
  | "truncated"
  | "unsafe-entry"
  | "unsupported-entry";

/** Typed tar/gzip failure; the message never echoes the full archive. */
export class TarArchiveError extends Error {
  readonly kind: TarArchiveErrorKind;
  /** Entry being processed when the failure was detected, when known. */
  readonly entryName: string | undefined;

  constructor(
    kind: TarArchiveErrorKind,
    message: string,
    options: { entryName?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "TarArchiveError";
    this.kind = kind;
    this.entryName = options.entryName;
  }
}

/** A tar member that may be extracted: a regular file or a directory. */
export interface TarEntry {
  /** Path relative to the archive root, forward slashes, leading `package/` stripped. */
  readonly name: string;
  readonly type: "directory" | "file";
  /** Data length in bytes (0 for directories). */
  readonly size: number;
  /** POSIX permission bits from the header. */
  readonly mode: number;
  /** Modification time in milliseconds, when the header/PAX disclosed it. */
  readonly mtimeMs: number | null;
}

/** Archive input: on-disk path (runtime) or in-memory bytes (tests). */
export type TarGzInput = Uint8Array | string;

/** Options for {@link listTarGzEntries}. */
export interface ListTarGzOptions {
  /** Leading path segment to strip. Defaults to `package`; `false` keeps it. */
  readonly stripLeadingDirectory?: string | false;
  readonly signal?: AbortSignal;
}

/** Options for {@link extractTarGz}. */
export interface ExtractTarGzOptions extends ListTarGzOptions {
  /** Directory that extracted paths are resolved under. Created when missing. */
  readonly destinationDir: string;
  /**
   * Keep or skip an entry. The callback receives the validated, normalized
   * entry; entries it declines are drained but never written. Platform trimming
   * (runtime-fetch) is expressed here.
   */
  readonly includeEntry?: (entry: TarEntry) => boolean | Promise<boolean>;
}

/** What {@link extractTarGz} actually wrote. */
export interface ExtractTarGzResult {
  /** Extracted files, relative to the destination, in archive order. */
  readonly files: readonly string[];
  /** Explicit directory entries created (parent dirs are implicit). */
  readonly directories: number;
  /** Entries drained because the include filter declined them. */
  readonly skippedEntries: number;
  /** Total file bytes written. */
  readonly bytesWritten: number;
}

interface TarHeader {
  readonly name: string;
  readonly prefix: string;
  readonly linkName: string;
  readonly type: string;
  readonly size: number;
  readonly mode: number;
  readonly mtimeMs: number | null;
}

interface ResolvedEntry {
  readonly name: string;
  readonly linkName: string;
  readonly size: number;
  readonly mtimeMs: number | null;
}

interface IterateOptions {
  readonly stripLeadingDirectory: string | false;
  readonly signal: AbortSignal | undefined;
}

interface TarEntryHandle {
  readonly entry: TarEntry;
  /** Drain the data (and its padding) without writing it. Idempotent. */
  discard(): Promise<void>;
  /** Stream the data to `target`, creating parent directories. */
  writeTo(target: string): Promise<void>;
}

/**
 * Read every extractable entry without touching the disk. Link and malformed
 * entries are refused exactly as they are during extraction, so this is a safe
 * way to inspect an archive before committing to it.
 */
export async function listTarGzEntries(
  input: TarGzInput,
  options: ListTarGzOptions = {},
): Promise<TarEntry[]> {
  const stream = openTarGzStream(input);
  const reader = new BlockReader(stream);
  const entries: TarEntry[] = [];
  try {
    for await (const handle of iterateTarEntries(reader, {
      stripLeadingDirectory:
        options.stripLeadingDirectory ?? DEFAULT_STRIP_DIRECTORY,
      signal: options.signal,
    })) {
      entries.push(handle.entry);
      await handle.discard();
    }
  } finally {
    destroyArchiveStream(stream);
  }
  return entries;
}

/**
 * Extract a `.tar.gz` archive into `destinationDir`, streaming from the gzip
 * stream. Throws {@link TarArchiveError} on a malformed, truncated or unsafe
 * archive. Entries already written before a later failure are left in place:
 * callers extract into a staging directory and commit with a rename, so a
 * partial tree is never mistaken for a finished one.
 */
export async function extractTarGz(
  input: TarGzInput,
  options: ExtractTarGzOptions,
): Promise<ExtractTarGzResult> {
  const destinationDir = resolve(options.destinationDir);
  await mkdir(destinationDir, { recursive: true });
  const stream = openTarGzStream(input);
  const reader = new BlockReader(stream);
  const files: string[] = [];
  let directories = 0;
  let skippedEntries = 0;
  let bytesWritten = 0;

  try {
    for await (const handle of iterateTarEntries(reader, {
      stripLeadingDirectory:
        options.stripLeadingDirectory ?? DEFAULT_STRIP_DIRECTORY,
      signal: options.signal,
    })) {
      const { entry } = handle;
      if (options.includeEntry && !(await options.includeEntry(entry))) {
        await handle.discard();
        skippedEntries += 1;
        continue;
      }
      const target = resolveEntryTarget(destinationDir, entry.name);
      if (entry.type === "directory") {
        await mkdir(target, { recursive: true });
        directories += 1;
        await handle.discard();
        continue;
      }
      await handle.writeTo(target);
      files.push(entry.name);
      bytesWritten += entry.size;
    }
  } catch (error) {
    throw asTarArchiveError(error);
  } finally {
    destroyArchiveStream(stream);
  }

  return { files, directories, skippedEntries, bytesWritten };
}

/**
 * Stream gzip output for a buffer or a file. The gzip stream surfaces source
 * read errors through `destroy(error)` so the reader below sees one error
 * channel instead of a silently truncated archive.
 */
function openTarGzStream(input: TarGzInput): Readable {
  const gunzip = createGunzip();
  const source =
    typeof input === "string"
      ? createReadStream(input)
      : Readable.from([Buffer.from(input)]);
  source.on("error", (error: Error) => gunzip.destroy(error));
  source.pipe(gunzip);
  return gunzip;
}

function destroyArchiveStream(stream: Readable): void {
  stream.destroy();
}

/**
 * Pull-based reader over the decompressed stream. `nextView` returns a view of
 * the current chunk, so file data is copied once (when written) and skipped
 * bytes are never buffered.
 */
class BlockReader {
  private readonly iterator: AsyncIterator<unknown>;
  private current: Buffer = Buffer.alloc(0);
  private cursor = 0;

  constructor(stream: Readable) {
    this.iterator = stream[Symbol.asyncIterator]();
  }

  /** Next available bytes (at most `maxLength`), or `null` at end of stream. */
  async nextView(maxLength: number): Promise<Buffer | null> {
    while (this.cursor >= this.current.length) {
      const next = await this.iterator.next();
      if (next.done) {
        this.current = Buffer.alloc(0);
        this.cursor = 0;
        return null;
      }
      this.current = chunkToBuffer(next.value);
      this.cursor = 0;
    }
    const take = Math.min(maxLength, this.current.length - this.cursor);
    const view = this.current.subarray(this.cursor, this.cursor + take);
    this.cursor += take;
    return view;
  }

  /** Exactly `length` bytes, or a `truncated` error. */
  async readExactly(length: number): Promise<Buffer> {
    if (length === 0) return Buffer.alloc(0);
    const parts: Buffer[] = [];
    let remaining = length;
    while (remaining > 0) {
      const view = await this.nextView(remaining);
      if (view === null) {
        throw new TarArchiveError(
          "truncated",
          `Tar archive ended ${remaining} byte(s) early.`,
        );
      }
      parts.push(view);
      remaining -= view.length;
    }
    if (parts.length === 1) {
      const part = parts[0];
      return part === undefined ? Buffer.alloc(0) : part;
    }
    return Buffer.concat(parts);
  }

  /** One 512-byte block, or `null` when the stream is already exhausted. */
  async readOptionalBlock(): Promise<Buffer | null> {
    const view = await this.nextView(BLOCK_SIZE);
    if (view === null) return null;
    if (view.length === BLOCK_SIZE) return view;
    const rest = await this.readExactly(BLOCK_SIZE - view.length);
    return Buffer.concat([view, rest]);
  }

  /** Discard exactly `length` bytes. */
  async skip(length: number): Promise<void> {
    let remaining = length;
    while (remaining > 0) {
      const view = await this.nextView(remaining);
      if (view === null) {
        throw new TarArchiveError(
          "truncated",
          `Tar archive ended ${remaining} byte(s) early.`,
        );
      }
      remaining -= view.length;
    }
  }
}

function chunkToBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new TarArchiveError("io", "Tar gzip stream produced a non-byte chunk.");
}

/**
 * Async generator over the archive's extractable entries. The consumer must
 * call exactly one of `writeTo`/`discard` on each handle; if it forgets, the
 * data is drained before the next header is read.
 */
async function* iterateTarEntries(
  reader: BlockReader,
  options: IterateOptions,
): AsyncGenerator<TarEntryHandle> {
  let pendingPax: Map<string, string> | null = null;
  let pendingLongName: string | null = null;
  let pendingLongLink: string | null = null;
  const globalPax = new Map<string, string>();

  for (;;) {
    assertNotAborted(options.signal);
    const block = await reader.readExactly(BLOCK_SIZE);
    if (isZeroBlock(block)) {
      const marker = await reader.readOptionalBlock();
      if (marker !== null && !isZeroBlock(marker)) {
        throw new TarArchiveError(
          "unsupported-entry",
          "Tar archive contains a non-zero block after the end-of-archive marker.",
        );
      }
      return;
    }

    const header = parseTarHeader(block);

    if (header.type === "x" || header.type === "g") {
      const data = await reader.readExactly(header.size);
      await reader.skip(paddingFor(header.size));
      const attributes = parsePaxRecords(data);
      if (header.type === "x") {
        pendingPax = attributes;
      } else {
        for (const [key, value] of attributes) globalPax.set(key, value);
      }
      continue;
    }

    if (header.type === "L") {
      pendingLongName = decodeLongName(await reader.readExactly(header.size));
      await reader.skip(paddingFor(header.size));
      continue;
    }

    if (header.type === "K") {
      pendingLongLink = decodeLongName(await reader.readExactly(header.size));
      await reader.skip(paddingFor(header.size));
      continue;
    }

    const entry = resolveEntry(
      header,
      pendingPax,
      globalPax,
      pendingLongName,
      pendingLongLink,
    );
    pendingPax = null;
    pendingLongName = null;
    pendingLongLink = null;
    const name = entry.name;
    const type = classifyEntryType(header.type, name);

    const segments = normalizeEntrySegments(name);
    const stripped = stripLeadingSegments(
      segments,
      options.stripLeadingDirectory,
    );
    if (stripped.length === 0) {
      await reader.skip(entry.size + paddingFor(entry.size));
      continue;
    }

    const tarEntry: TarEntry = {
      name: stripped.join("/"),
      type,
      size: type === "directory" ? 0 : entry.size,
      mode: header.mode,
      mtimeMs: entry.mtimeMs,
    };
    if (type === "file" && entry.linkName.length > 0) {
      throw new TarArchiveError(
        "unsafe-entry",
        `Tar entry ${JSON.stringify(name)} carries a link target and is refused.`,
        { entryName: name },
      );
    }

    let consumed = false;
    const handle: TarEntryHandle = {
      entry: tarEntry,
      async discard(): Promise<void> {
        if (consumed) return;
        consumed = true;
        await reader.skip(entry.size);
        await reader.skip(paddingFor(entry.size));
      },
      async writeTo(target: string): Promise<void> {
        if (consumed) {
          throw new TarArchiveError(
            "io",
            `Tar entry ${JSON.stringify(name)} data was already consumed.`,
            { entryName: name },
          );
        }
        consumed = true;
        await writeEntryData(reader, entry.size, target);
        await reader.skip(paddingFor(entry.size));
      },
    };
    yield handle;
    if (!consumed) await handle.discard();
  }
}

async function writeEntryData(
  reader: BlockReader,
  size: number,
  target: string,
): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const stream = createWriteStream(target, { flags: "w" });
  try {
    let remaining = size;
    while (remaining > 0) {
      const chunk = await reader.nextView(remaining);
      if (chunk === null) {
        throw new TarArchiveError(
          "truncated",
          `Tar archive ended while writing ${JSON.stringify(target)}.`,
        );
      }
      remaining -= chunk.length;
      if (!stream.write(chunk)) {
        await once(stream, "drain");
      }
    }
    stream.end();
    await once(stream, "finish");
  } finally {
    stream.destroy();
  }
}

function parseTarHeader(block: Buffer): TarHeader {
  const name = readCString(block, 0, 100);
  const mode = readOctal(block, 100, 8, "mode", name);
  const size = readOctal(block, 124, 12, "size", name);
  const mtimeSeconds = readOctalOrNull(block, 136, 12, "mtime", name);
  const expectedChecksum = readOctal(
    block,
    CHECKSUM_OFFSET,
    CHECKSUM_LENGTH,
    "checksum",
    name,
  );
  verifyChecksum(block, expectedChecksum, name);
  const typeByte = block[156];
  const type = String.fromCharCode(typeByte === undefined ? 0 : typeByte);
  const linkName = readCString(block, 157, 100);
  const prefix = readCString(block, 345, 155);
  return {
    name,
    prefix,
    linkName,
    type,
    size,
    mode,
    mtimeMs: mtimeSeconds === null ? null : mtimeSeconds * 1000,
  };
}

function resolveEntry(
  header: TarHeader,
  pendingPax: Map<string, string> | null,
  globalPax: Map<string, string>,
  longName: string | null,
  longLink: string | null,
): ResolvedEntry {
  const paxName = pendingPax?.get("path") ?? globalPax.get("path");
  const paxLink = pendingPax?.get("linkpath") ?? globalPax.get("linkpath");
  const paxSize = pendingPax?.get("size") ?? globalPax.get("size");
  const paxMtime = pendingPax?.get("mtime") ?? globalPax.get("mtime");
  const ustarName =
    header.prefix.length > 0 ? `${header.prefix}/${header.name}` : header.name;
  return {
    name: longName ?? paxName ?? ustarName,
    linkName: longLink ?? paxLink ?? header.linkName,
    size: paxSize === undefined ? header.size : parsePaxSize(paxSize),
    mtimeMs:
      paxMtime === undefined
        ? header.mtimeMs
        : parsePaxMtimeSeconds(paxMtime) * 1000,
  };
}

function classifyEntryType(type: string, name: string): "directory" | "file" {
  if (type === "5") return "directory";
  if (type === "0" || type === "\0" || type === "7") return "file";
  if (type === "1" || type === "2") {
    const kind = type === "1" ? "hard link" : "symbolic link";
    throw new TarArchiveError(
      "unsafe-entry",
      `Tar entry ${JSON.stringify(name)} is a ${kind}; link entries are refused.`,
      { entryName: name },
    );
  }
  throw new TarArchiveError(
    "unsupported-entry",
    `Tar entry ${JSON.stringify(name)} uses unsupported type ${JSON.stringify(type)}.`,
    { entryName: name },
  );
}

/**
 * Split an entry name into validated segments. Rejects absolute paths, Windows
 * drive/UNC prefixes, NTFS stream colons, NUL bytes and `..` traversal.
 * Redundant `.`/empty segments are dropped (they cannot escape anything).
 */
function normalizeEntrySegments(name: string): string[] {
  if (name.includes("\0")) {
    throw new TarArchiveError(
      "unsafe-entry",
      "Tar entry name contains a NUL byte.",
      {
        entryName: name,
      },
    );
  }
  const slashed = name.replace(/\\/g, "/");
  if (
    slashed.startsWith("/") ||
    slashed.startsWith("//") ||
    /^[A-Za-z]:/.test(slashed)
  ) {
    throw new TarArchiveError(
      "unsafe-entry",
      `Tar entry ${JSON.stringify(name)} uses an absolute or drive-qualified path.`,
      { entryName: name },
    );
  }
  const segments: string[] = [];
  for (const segment of slashed.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      throw new TarArchiveError(
        "unsafe-entry",
        `Tar entry ${JSON.stringify(name)} contains a parent-directory segment.`,
        { entryName: name },
      );
    }
    if (segment.includes(":")) {
      throw new TarArchiveError(
        "unsafe-entry",
        `Tar entry ${JSON.stringify(name)} contains a colon, which is not allowed in an extracted path.`,
        { entryName: name },
      );
    }
    segments.push(segment);
  }
  return segments;
}

function stripLeadingSegments(
  segments: readonly string[],
  strip: string | false,
): string[] {
  if (strip === false) return [...segments];
  const prefix = strip
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment.length > 0);
  if (prefix.length === 0) return [...segments];
  if (segments.length < prefix.length) return [...segments];
  for (let index = 0; index < prefix.length; index += 1) {
    if (segments[index] !== prefix[index]) return [...segments];
  }
  return segments.slice(prefix.length);
}

/**
 * Resolve a validated relative name under the destination and prove it stayed
 * there. This is defense-in-depth: platform path-resolution quirks are exactly
 * where a lexical check can disagree with the filesystem.
 */
function resolveEntryTarget(destinationDir: string, name: string): string {
  const segments = name.split("/");
  const root = resolve(destinationDir);
  const target = resolve(root, ...segments);
  const nested = relative(root, target);
  if (
    nested === "" ||
    nested === ".." ||
    nested.startsWith(`..${sep}`) ||
    isAbsolute(nested)
  ) {
    throw new TarArchiveError(
      "unsafe-entry",
      `Tar entry ${JSON.stringify(name)} escapes the destination directory.`,
      { entryName: name },
    );
  }
  return target;
}

function parsePaxRecords(data: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) {
      throw new TarArchiveError(
        "unsupported-entry",
        "PAX extended header record has no length separator.",
      );
    }
    const lengthText = data.toString("ascii", offset, space);
    if (!/^[0-9]+$/.test(lengthText)) {
      throw new TarArchiveError(
        "unsupported-entry",
        "PAX extended header record has an invalid length.",
      );
    }
    const length = Number.parseInt(lengthText, 10);
    if (
      !Number.isSafeInteger(length) ||
      length <= space - offset ||
      offset + length > data.length
    ) {
      throw new TarArchiveError(
        "unsupported-entry",
        "PAX extended header record length is out of range.",
      );
    }
    const body = data
      .subarray(space + 1, offset + length)
      .toString("utf8")
      .replace(/\n$/, "");
    const separator = body.indexOf("=");
    if (separator <= 0) {
      throw new TarArchiveError(
        "unsupported-entry",
        "PAX extended header record is missing its key/value separator.",
      );
    }
    records.set(body.slice(0, separator), body.slice(separator + 1));
    offset += length;
  }
  return records;
}

function parsePaxSize(value: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new TarArchiveError(
      "unsupported-entry",
      `PAX size ${JSON.stringify(value)} is not a non-negative integer.`,
    );
  }
  const size = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(size)) {
    throw new TarArchiveError(
      "unsupported-entry",
      `PAX size ${JSON.stringify(value)} is out of range.`,
    );
  }
  return size;
}

function parsePaxMtimeSeconds(value: string): number {
  const seconds = Number.parseFloat(value);
  if (!Number.isFinite(seconds)) {
    throw new TarArchiveError(
      "unsupported-entry",
      `PAX mtime ${JSON.stringify(value)} is not a number.`,
    );
  }
  return seconds;
}

function readCString(block: Buffer, offset: number, length: number): string {
  const bytes = block.subarray(offset, offset + length);
  const end = bytes.indexOf(0);
  return bytes.toString("utf8", 0, end < 0 ? bytes.length : end);
}

function readOctal(
  block: Buffer,
  offset: number,
  length: number,
  field: string,
  entryName: string,
): number {
  const value = readOctalOrNull(block, offset, length, field, entryName);
  return value === null ? 0 : value;
}

function readOctalOrNull(
  block: Buffer,
  offset: number,
  length: number,
  field: string,
  entryName: string,
): number | null {
  const bytes = block.subarray(offset, offset + length);
  const first = bytes[0];
  if (first !== undefined && (first & 0x80) !== 0) {
    throw new TarArchiveError(
      "unsupported-entry",
      `Tar header field ${field} for ${JSON.stringify(entryName)} uses base-256 encoding, which is not supported.`,
      { entryName },
    );
  }
  const text = bytes.toString("ascii").replace(/\0.*$/s, "").trim();
  if (text.length === 0) return null;
  if (!/^[0-7]+$/.test(text)) {
    throw new TarArchiveError(
      "unsupported-entry",
      `Tar header field ${field} for ${JSON.stringify(entryName)} is not octal.`,
      { entryName },
    );
  }
  return Number.parseInt(text, 8);
}

function verifyChecksum(block: Buffer, expected: number, name: string): void {
  let unsigned = 0;
  let signed = 0;
  for (let index = 0; index < BLOCK_SIZE; index += 1) {
    const isChecksumByte =
      index >= CHECKSUM_OFFSET && index < CHECKSUM_OFFSET + CHECKSUM_LENGTH;
    const byte = isChecksumByte ? 0x20 : (block[index] ?? 0);
    unsigned += byte;
    signed += byte > 0x7f ? byte - 0x100 : byte;
  }
  if (expected !== unsigned && expected !== signed) {
    throw new TarArchiveError(
      "checksum",
      `Tar header checksum mismatch for ${JSON.stringify(name)} (expected ${expected}, computed ${unsigned}).`,
      { entryName: name },
    );
  }
}

function isZeroBlock(block: Buffer): boolean {
  for (const byte of block) {
    if (byte !== 0) return false;
  }
  return true;
}

function paddingFor(size: number): number {
  return (BLOCK_SIZE - (size % BLOCK_SIZE)) % BLOCK_SIZE;
}

function decodeLongName(data: Buffer): string {
  const end = data.indexOf(0);
  return data
    .subarray(0, end < 0 ? data.length : end)
    .toString("utf8")
    .replace(/\n$/, "");
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error("Tar extraction aborted.");
  error.name = "AbortError";
  throw error;
}

function asTarArchiveError(error: unknown): unknown {
  if (error instanceof TarArchiveError) return error;
  if (error instanceof Error && error.name === "AbortError") return error;
  const code = (error as { code?: unknown } | null)?.code;
  const kind: TarArchiveErrorKind =
    typeof code === "string" && code.startsWith("Z_") ? "gzip" : "io";
  const message =
    error instanceof Error ? error.message : `Unknown error: ${String(error)}`;
  return new TarArchiveError(
    kind,
    `Failed to extract tar.gz archive: ${message}`,
    {
      cause: error,
    },
  );
}
