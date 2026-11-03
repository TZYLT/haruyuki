/**
 * Memory-side corpus for vector recall (feature 48, package B4).
 *
 * The memory arm embeds **paragraph records**, not whole files (48-1 §6.2): a
 * unit is `memory-search`'s paragraph (`MEMORY_RECORD_MAX_LINES = 20` lines at
 * most) and recall/injection stay parent-scoped, exactly like a transcript
 * message. This module turns one workspace file into those parents and their B1
 * chunk plans; it deliberately stops there — writing the index is B2/B3's job,
 * and this file performs no writes at all.
 *
 * What a parent carries, and why (48-2 §4.2/§4.3):
 *
 * - `parentId` is `memory:<path>#L<start>-L<end>` — one id per paragraph, so a
 *   file with several paragraphs contributes several independent parents and
 *   never lets one paragraph's chunks crowd out another's. It is also parseable
 *   (`parseMemoryVectorParentId`), which is how injection re-reads the parent
 *   from the live workspace before trusting a hit.
 * - `parentLineSpan` on every chunk record is the chunk's *file*-absolute line
 *   span. It is what lets the injection side place a `focusChar` back onto the
 *   file's lines without re-chunking; B4 verifies the span before injecting.
 * - `titlePrefix` is the `文件路径 › 章节标题` label. It is stored on the parent
 *   rather than embedded: the requirement fixes memory injection to “best line
 *   ±2 lines” plus a prefix (48-1 §6.2), so prepending it to the embedded text
 *   would put metadata into the vector space and shift `focusChar`.
 * - `fileKey` names the B2 unit directory (`…/memory/<fileKey>/`). It is a safe
 *   path segment derived from the workspace path (48-2 §4.2), stable across
 *   runs and unique per path.
 *
 * Invalidation follows 48-1 §6.2 item 10: the memory workspace is read through
 * the current files, and a plan is keyed by each file's `mtime` + `size` plus
 * the committed MemFS revision. The revision catches a file that was restored or
 * checked out with a preserved mtime; the per-file stat catches ordinary edits
 * without paying for a git call per file. `isMemoryVectorFileStale` is the
 * comparison; `buildMemoryVectorPlan` returns the signature the caller stores
 * with the index so a later build can tell whether it must rebuild.
 *
 * Layer: `backend/local/`. Imports `utils/`, the same-directory chunk/index/
 * search/snippet modules and `system-prompt-compilation.ts` (for the committed
 * revision only); it must not import `reminders/`, `cli/`, `websocket/` or
 * `agent/` (the embedding leaf rule). No writes, no clock, no RNG.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { decodeUtf8TextStrict } from "@/utils/text-files";
import {
  buildEmbeddingChunkPlan,
  type EmbeddingChunkOptions,
  type EmbeddingChunkPlan,
} from "./embedding-chunk";
import {
  type EmbeddingChunkRecordInput,
  type EmbeddingParentLineSpan,
  embeddingChunkRecordsFromPlan,
} from "./embedding-format";
import { collectRecallFiles, splitMemoryParagraphs } from "./memory-search";
import { lineSpanWithinParent, memoryTitlePrefix } from "./recall-snippets";
import { getCommittedMemfsRevision } from "./system-prompt-compilation";

/** Every vector-side memory parent id starts with this. */
export const MEMORY_VECTOR_PARENT_PREFIX = "memory:";

/** One memory file's stat identity, plus the revision its plan was built at. */
export type MemoryVectorFileSignature = {
  /** Workspace-relative, forward-slash path. */
  path: string;
  /** Safe path segment used as the B2 unit directory name. */
  fileKey: string;
  mtimeMs: number;
  size: number;
  /** Committed MemFS HEAD when the workspace is a repository. */
  gitRevision?: string;
};

/** One paragraph record and the chunk plan built from it. */
export type MemoryVectorParent = {
  /** `memory:<path>#L<start>-L<end>`; unique per paragraph. */
  parentId: string;
  path: string;
  fileKey: string;
  /** 1-based first line of `text` inside the file, inclusive. */
  startLine: number;
  /** 1-based last line of `text` inside the file, inclusive. */
  endLine: number;
  /** `文件路径 › 章节标题` (or the bare path with no heading). */
  titlePrefix: string;
  /** The parent's original text, exactly what B1 chunked. */
  text: string;
  plan: EmbeddingChunkPlan;
  /** Record inputs; every one carries `parentLineSpan`. */
  records: EmbeddingChunkRecordInput[];
};

export type MemoryVectorFilePlan = {
  signature: MemoryVectorFileSignature;
  parents: MemoryVectorParent[];
};

export type MemoryVectorPlanStats = {
  files: number;
  /** Files that existed but could not be read as UTF-8 text. */
  skippedFiles: number;
  parents: number;
  /** Parents B1 marked lexical-only (pure fenced code, empty prose). */
  skippedParents: number;
  chunks: number;
  bytes: number;
};

export type MemoryVectorPlan = {
  files: MemoryVectorFilePlan[];
  /**
   * Aggregate corpus identity: the revision plus every file's stat identity.
   * Store it with the index; a different value means rebuild (48-1 §6.2).
   */
  signature: string;
  gitRevision?: string;
  stats: MemoryVectorPlanStats;
};

export type MemoryVectorPlanOptions = {
  /**
   * Revision to stamp without asking git. Tests and already-running builds pass
   * it so a plan is reproducible; production omits it and reads HEAD.
   */
  gitRevision?: string;
  /** Cooperative stop check, one per file (a build is cancellable). */
  shouldStop?: () => boolean;
  /** Overrides forwarded to B1; defaults are the requirement's 200/256/32. */
  chunkOptions?: EmbeddingChunkOptions;
};

/** A parent re-read from the live workspace, ready for the injection mapper. */
export type MemoryVectorParentText = {
  text: string;
  /** Every line of the source document, for title prefixes and line numbers. */
  lines: string[];
  /** 1-based first line of `text` inside `lines`. */
  startLine: number;
};

/**
 * Normalises a memory path the way the rest of the backend reports it:
 * forward slashes, no leading `./`. Keeps the value the index and the retriever
 * both see identical.
 */
export function normalizeMemoryPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * The B2 unit directory key for a memory file.
 *
 * `embedding-format.ts` validates a `memoryFileKey` as one safe path component
 * (`[A-Za-z0-9][A-Za-z0-9._-]*`), and a workspace path is neither — it may nest,
 * be non-ASCII, or be too long for Windows. The key keeps a readable slug from
 * the file name and appends a hash of the full path: unique per path, stable
 * across runs, and never able to escape the recall root.
 */
export function memoryFileKey(path: string): string {
  const normalized = normalizeMemoryPath(path);
  const base = normalized.split("/").pop() ?? "memory";
  const slug =
    base
      .replace(/\.md$/i, "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[^A-Za-z0-9]+/, "")
      .slice(0, 48) || "memory";
  const hash = createHash("sha256")
    .update(normalized)
    .digest("hex")
    .slice(0, 8);
  return `${slug}-${hash}`;
}

/** `memory:<path>#L<start>-L<end>`, the parent id for one paragraph. */
export function memoryVectorParentId(
  path: string,
  startLine: number,
  endLine: number,
): string {
  return `${MEMORY_VECTOR_PARENT_PREFIX}${normalizeMemoryPath(path)}#L${startLine}-L${endLine}`;
}

/**
 * Parses a parent id back into its paragraph identity, or `undefined` when the
 * id was not produced by {@link memoryVectorParentId}.
 *
 * The path is taken from the *last* `#L` marker, because `#` is a legal file
 * character and the line span is the only part with a fixed shape.
 */
export function parseMemoryVectorParentId(
  parentId: string,
): { path: string; startLine: number; endLine: number } | undefined {
  if (!parentId.startsWith(MEMORY_VECTOR_PARENT_PREFIX)) return undefined;
  const body = parentId.slice(MEMORY_VECTOR_PARENT_PREFIX.length);
  const marker = body.lastIndexOf("#L");
  if (marker <= 0) return undefined;
  const path = body.slice(0, marker);
  const span = /^(\d+)-L(\d+)$/.exec(body.slice(marker + 2));
  if (span === null) return undefined;
  const startLine = Number(span[1]);
  const endLine = Number(span[2]);
  if (
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine
  ) {
    return undefined;
  }
  return { path, startLine, endLine };
}

/**
 * Lines of a memory document, split the way `memory-search` splits them: CRLF
 * normalised, and the phantom empty element a trailing newline produces dropped
 * so a reported `endLine` never points one past the last line with text.
 */
function splitDocumentLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

type MemoryDocument = { lines: string[]; bytes: number };

function readMemoryDocument(absolutePath: string): MemoryDocument | undefined {
  try {
    const bytes = readFileSync(absolutePath);
    return {
      lines: splitDocumentLines(decodeUtf8TextStrict(bytes, absolutePath)),
      bytes: bytes.length,
    };
  } catch {
    // A binary or non-UTF-8 file is not a recall failure: the rest of the
    // workspace is still embedded, and the count is reported.
    return undefined;
  }
}

function absoluteMemoryPath(memoryDir: string, path: string): string {
  return join(memoryDir, ...normalizeMemoryPath(path).split("/"));
}

/** Stat identity of one workspace file; `undefined` when it cannot be read. */
export function readMemoryVectorFileSignature(
  memoryDir: string,
  path: string,
  options: { gitRevision?: string } = {},
): MemoryVectorFileSignature | undefined {
  const normalized = normalizeMemoryPath(path);
  try {
    const stats = statSync(absoluteMemoryPath(memoryDir, normalized));
    return {
      path: normalized,
      fileKey: memoryFileKey(normalized),
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      ...(options.gitRevision === undefined
        ? {}
        : { gitRevision: options.gitRevision }),
    };
  } catch {
    return undefined;
  }
}

/**
 * Whether a stored signature must be rebuilt: any change of path, mtime, size or
 * the committed revision means the plan no longer describes the workspace.
 *
 * A revision-only change is deliberately a rebuild: memory is a git-backed
 * workspace, and a restore/checkout can put content back with an old mtime that
 * a stat comparison would miss (48-1 §6.2 item 10).
 */
export function isMemoryVectorFileStale(
  stored: MemoryVectorFileSignature,
  current: MemoryVectorFileSignature,
): boolean {
  return (
    stored.path !== current.path ||
    stored.mtimeMs !== current.mtimeMs ||
    stored.size !== current.size ||
    stored.gitRevision !== current.gitRevision
  );
}

/**
 * Builds one file's paragraph parents and chunk plans.
 *
 * Returns `undefined` when the file cannot be read as UTF-8; the caller counts
 * it and keeps going, because one unreadable file must not stop a build.
 */
export function buildMemoryVectorFilePlan(
  memoryDir: string,
  path: string,
  options: MemoryVectorPlanOptions & { gitRevision?: string } = {},
): MemoryVectorFilePlan | undefined {
  const signature = readMemoryVectorFileSignature(memoryDir, path, {
    ...(options.gitRevision === undefined
      ? {}
      : { gitRevision: options.gitRevision }),
  });
  if (signature === undefined) return undefined;
  const document = readMemoryDocument(
    absoluteMemoryPath(memoryDir, signature.path),
  );
  if (document === undefined) return undefined;

  const parents: MemoryVectorParent[] = [];
  for (const paragraph of splitMemoryParagraphs(document.lines)) {
    const text = document.lines
      .slice(paragraph.startLine - 1, paragraph.endLine)
      .join("\n");
    const parentId = memoryVectorParentId(
      signature.path,
      paragraph.startLine,
      paragraph.endLine,
    );
    const plan = buildEmbeddingChunkPlan(
      { parentId, text },
      options.chunkOptions,
    );
    const records = embeddingChunkRecordsFromPlan(plan, {
      parentLineSpan: (chunk) =>
        lineSpanWithinParent({
          parentText: text,
          startChar: chunk.startChar,
          endChar: chunk.endChar,
          parentStartLine: paragraph.startLine,
        }),
    });
    parents.push({
      parentId,
      path: signature.path,
      fileKey: signature.fileKey,
      startLine: paragraph.startLine,
      endLine: paragraph.endLine,
      titlePrefix: memoryTitlePrefix(
        signature.path,
        document.lines,
        paragraph.startLine,
      ),
      text,
      plan,
      records,
    });
  }
  return { signature, parents };
}

/**
 * Builds the whole memory-side corpus plan. Read-only: no index is written, and
 * no path under the harness root is touched.
 *
 * Files are the same set `memory-search` searches (`collectRecallFiles`), so the
 * vector arm and the lexical arm can never disagree about which files exist —
 * core memory already inlined in the prompt, skills, and `.git` are excluded on
 * both sides by construction.
 */
export function buildMemoryVectorPlan(
  memoryDir: string,
  options: MemoryVectorPlanOptions = {},
): MemoryVectorPlan {
  const gitRevision =
    options.gitRevision ?? getCommittedMemfsRevision(memoryDir);
  const files: MemoryVectorFilePlan[] = [];
  const stats: MemoryVectorPlanStats = {
    files: 0,
    skippedFiles: 0,
    parents: 0,
    skippedParents: 0,
    chunks: 0,
    bytes: 0,
  };

  for (const file of collectRecallFiles(memoryDir)) {
    if (options.shouldStop?.() === true) break;
    const plan = buildMemoryVectorFilePlan(memoryDir, file.path, {
      ...options,
      ...(gitRevision === undefined ? {} : { gitRevision }),
    });
    if (plan === undefined) {
      stats.skippedFiles += 1;
      continue;
    }
    files.push(plan);
    stats.files += 1;
    stats.bytes += plan.signature.size;
    for (const parent of plan.parents) {
      stats.parents += 1;
      stats.chunks += parent.records.length;
      if (parent.plan.skipVector) stats.skippedParents += 1;
    }
  }

  return {
    files,
    signature: memoryVectorCorpusSignature(gitRevision, files),
    ...(gitRevision === undefined ? {} : { gitRevision }),
    stats,
  };
}

/**
 * Digest of every file signature in the corpus plus the committed revision.
 *
 * This is the value a build stores next to the index: equal means the corpus is
 * unchanged, and no per-file comparison is needed to skip a rebuild.
 */
export function memoryVectorCorpusSignature(
  gitRevision: string | undefined,
  files: readonly MemoryVectorFilePlan[],
): string {
  const hash = createHash("sha256");
  hash.update(gitRevision ?? "");
  const signatures = files
    .map((file) => file.signature)
    .sort((left, right) => left.path.localeCompare(right.path));
  for (const signature of signatures) {
    hash.update(
      `\n${signature.path}\t${signature.mtimeMs}\t${signature.size}\t${signature.gitRevision ?? ""}`,
    );
  }
  return hash.digest("hex").slice(0, 32);
}

/**
 * Re-reads one memory parent from the live workspace: the callback E2 passes to
 * the injection mapper for memory hits.
 *
 * Path traversal is rejected rather than normalised away: the parent id comes
 * from an index file on disk, and a corrupted or hostile one must not be able to
 * read outside the memory workspace (48-1 §8.2: a corrupt index is discarded,
 * never trusted).
 */
export function readMemoryVectorParentText(
  memoryDir: string,
  parentId: string,
): MemoryVectorParentText | undefined {
  const parsed = parseMemoryVectorParentId(parentId);
  if (parsed === undefined) return undefined;
  const root = resolve(memoryDir);
  const absolute = resolve(root, ...parsed.path.split("/"));
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
    return undefined;
  }
  const document = readMemoryDocument(absolute);
  if (document === undefined || document.lines.length === 0) return undefined;
  const startLine = Math.max(1, parsed.startLine);
  const endLine = Math.min(document.lines.length, parsed.endLine);
  if (startLine > document.lines.length || endLine < startLine) {
    return undefined;
  }
  return {
    text: document.lines.slice(startLine - 1, endLine).join("\n"),
    lines: document.lines,
    startLine,
  };
}

/** Re-exported so callers can type the span without importing B2's module. */
export type MemoryVectorParentLineSpan = EmbeddingParentLineSpan;
