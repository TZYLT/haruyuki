import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  detectMemoryFormat,
  isCoreMemoryPath,
  isProjectedMemoryPath,
} from "@/agent/memory-format";
import { decodeUtf8TextStrict } from "@/utils/text-files";
import {
  matchesPhrase,
  type ParsedQuery,
  parseQuery,
  type RankableSearchRecord,
  rankMatches,
  type SearchStopSignal,
  termFrequency,
  tokenize,
} from "./transcript-search";

/**
 * The MemFS memory retriever behind passive recall.
 *
 * The compiled system prompt inlines two things: the root core memory files, and
 * — for every projected directory — its `MEMORY.md` *path*. The body of a child
 * index never reaches the model, and neither does anything under a directory with
 * no index; no tool even tells the model those files exist. This module is the
 * inverse of that projection: it scans the memory workspace on demand and returns
 * the passages whose bodies the prompt left out.
 *
 * Four rules are load-bearing.
 *
 * - **Scope mirrors the projection, inverted.** A file is searchable exactly when
 *   its body is *not* inlined — `isCoreMemoryPath` is that predicate, verbatim —
 *   minus the skills subtree, which belongs to the skills surface rather than to
 *   recall. Nothing here re-derives the boundary, so the two sides cannot drift.
 * - **Read through the workspace, not through git.** HEAD is what the prompt was
 *   compiled from; the retriever reads current files, so a just-written memory is
 *   recallable before it is committed. The cost is that a half-written file can be
 *   recalled, which is the documented trade (《26》§5.3).
 * - **Scan, do not index.** The measured corpus is ~30 files / 0.5 MB per agent,
 *   about 10 ms end to end; an index would buy little and add the drift surface
 *   the transcript side already has to police.
 * - **Only `.md`.** The projection itself only ever considers Markdown, so a
 *   `.ts` or `.png` in the workspace is not a deferred memory — the model was
 *   never shown a path for it — and mod source that scores as prose is noise.
 */

/** Lines of context returned on each side of the hit line. */
export const MEMORY_EXCERPT_LINES = 2;

/**
 * A paragraph longer than this is split at a line boundary. Without a cap the
 * longest real paragraph is 5,640 characters against a 176-character median,
 * which lets one section's length normalization swamp its own term frequency.
 */
export const MEMORY_RECORD_MAX_LINES = 20;

/**
 * A safety cap, not a product default. The caller owns the final budget (top-3
 * across both sources), and ranking is unaffected by this value — it only bounds
 * how many excerpts are cut. It is deliberately small because cutting an excerpt
 * re-tokenizes the winning paragraph's lines: on the measured corpus the scan
 * itself is ~12 ms, and a cap of 50 doubled it.
 */
export const MEMORY_SEARCH_DEFAULT_LIMIT = 10;

const MEMORY_FILE_EXTENSION = ".md";
const SKILLS_DIRECTORY = "skills";
const GIT_DIRECTORY = ".git";

/**
 * How the compiled projection treats a file.
 *
 * - `deferred`: the projection's directory tree reaches this file — it either
 *   names the file itself (a child `MEMORY.md` index, whose body it replaces with
 *   a `<directory … index=… />` pointer) or points at an ancestor index that can
 *   lead to it. This is the blind spot the feature exists for.
 * - `unlisted`: no ancestor directory is projected, so the prompt does not even
 *   imply the file exists.
 */
export type MemoryProjectionPlacement = "deferred" | "unlisted";

export type MemorySearchEntry = {
  /** Workspace-relative, forward-slash, e.g. `reference/plan/x.md`. */
  path: string;
  /** 1-based first line of `text`, inclusive. */
  startLine: number;
  /** 1-based last line of `text`, inclusive. */
  endLine: number;
  /** The excerpt: `startLine` through `endLine`, joined with newlines. */
  text: string;
  /** BM25 score of the paragraph this excerpt was cut from. */
  score: number;
  placement: MemoryProjectionPlacement;
};

export type MemorySearchStats = {
  /** Files read and searched. */
  files: number;
  bytes: number;
  /** Paragraph records built from those files. */
  records: number;
  /** Files skipped because they were unreadable or not valid UTF-8. */
  skippedFiles: number;
};

export type MemorySearchResult = {
  /** Ranked best-first. Empty is a normal answer, never an error. */
  entries: MemorySearchEntry[];
  stats: MemorySearchStats;
};

export type MemorySearchOptions = {
  /** Lines of context on each side of the hit line. Default {@link MEMORY_EXCERPT_LINES}. */
  excerptLines?: number;
  limit?: number;
  minScore?: number;
  /**
   * Cooperative time budget (feature ②). The scan reads every workspace file,
   * so it is checked once per file; a truncated scan returns what it has read.
   * Omitted by callers with no budget, which is every caller but recall.
   */
  shouldStop?: SearchStopSignal;
};

export type MemoryRecallFile = {
  path: string;
  absolutePath: string;
  placement: MemoryProjectionPlacement;
};

export type MemoryParagraph = {
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
};

type MemoryRecord = RankableSearchRecord & {
  path: string;
  startLine: number;
  endLine: number;
  placement: MemoryProjectionPlacement;
};

type ScoredMemoryRecord = MemoryRecord & { score: number };

function walkMarkdownFiles(
  directory: string,
  prefix: string,
  paths: string[],
): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      // A memory directory is a git repository. Recursing into `.git` is not a
      // rounding error: it turns the measured 40 files / 1.0 MB into 2,447 files
      // / 7.7 MB, most of it compressed objects that are not text at all.
      if (entry.name === GIT_DIRECTORY) continue;
      walkMarkdownFiles(join(directory, entry.name), relative, paths);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(MEMORY_FILE_EXTENSION)) continue;
    paths.push(relative);
  }
}

/**
 * Every Markdown file in the workspace that recall may search, in stable order.
 *
 * The format is detected the same way prompt compilation detects it — presence of
 * a root `MEMORY.md` — because the two answers have to agree: the exclusion below
 * is only correct relative to the format the projection was rendered under.
 */
export function collectRecallFiles(memoryDir: string): MemoryRecallFile[] {
  const paths: string[] = [];
  walkMarkdownFiles(memoryDir, "", paths);
  paths.sort();

  const allPaths = new Set(paths);
  const format = detectMemoryFormat(memoryDir, false);
  const files: MemoryRecallFile[] = [];

  for (const path of paths) {
    // Already inlined verbatim in the prompt, so recalling it is pure noise.
    if (isCoreMemoryPath(path, format)) continue;
    // Skills are reachable through the skills surface; recall must not become a
    // second, worse way to find them.
    if (path === SKILLS_DIRECTORY || path.startsWith(`${SKILLS_DIRECTORY}/`)) {
      continue;
    }
    files.push({
      path,
      absolutePath: join(memoryDir, path),
      placement: isProjectedMemoryPath(path, allPaths, format)
        ? "deferred"
        : "unlisted",
    });
  }

  return files;
}

/**
 * Splits a file's lines into paragraph records.
 *
 * A paragraph is a maximal run of non-blank lines, cut at `maxLines` so one long
 * section cannot dominate the corpus statistics. Splitting is line-aligned on
 * purpose: a record boundary must never fall inside a line, or the excerpt it
 * produces would not correspond to anything in the file.
 */
export function splitMemoryParagraphs(
  lines: readonly string[],
  maxLines: number = MEMORY_RECORD_MAX_LINES,
): MemoryParagraph[] {
  const paragraphs: MemoryParagraph[] = [];
  let start = -1;

  const flush = (endExclusive: number): void => {
    if (start === -1) return;
    for (let from = start; from < endExclusive; from += maxLines) {
      paragraphs.push({
        startLine: from + 1,
        endLine: Math.min(from + maxLines, endExclusive),
      });
    }
    start = -1;
  };

  for (let index = 0; index < lines.length; index += 1) {
    if ((lines[index] ?? "").trim().length === 0) {
      flush(index);
      continue;
    }
    if (start === -1) start = index;
    if (index === lines.length - 1) flush(index + 1);
  }

  return paragraphs;
}

/**
 * Splits text into lines, dropping the empty final element a trailing newline
 * produces. Keeping it would put a phantom blank line at the end of every
 * excerpt cut from the last paragraph of a file, and would shift the reported
 * `endLine` one past the last line that actually holds text.
 */
function splitMemoryLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

function readMemoryDocument(
  file: MemoryRecallFile,
  stats: MemorySearchStats,
): { lines: string[]; records: MemoryRecord[] } | undefined {
  let text: string;
  try {
    const bytes = readFileSync(file.absolutePath);
    text = decodeUtf8TextStrict(bytes, file.absolutePath);
    stats.bytes += bytes.length;
  } catch {
    // A binary or non-UTF-8 file in the workspace is not a recall failure: the
    // rest of the corpus is still searched and the count is reported.
    stats.skippedFiles += 1;
    return undefined;
  }
  stats.files += 1;

  const lines = splitMemoryLines(text);
  const records: MemoryRecord[] = [];
  for (const paragraph of splitMemoryParagraphs(lines)) {
    const paragraphText = lines
      .slice(paragraph.startLine - 1, paragraph.endLine)
      .join("\n")
      .trim();
    const tokens = tokenize(paragraphText);
    if (tokens.length === 0) continue;
    records.push({
      path: file.path,
      startLine: paragraph.startLine,
      endLine: paragraph.endLine,
      placement: file.placement,
      normalizedText: tokens.join(" "),
      tokens,
      isSearchEcho: false,
    });
  }

  stats.records += records.length;
  return { lines, records };
}

/**
 * The line the excerpt centers on.
 *
 * Ranking happens per paragraph, but the excerpt is cut per line, so the record
 * has to nominate its own best line: most distinct query terms first, then total
 * frequency, then earliest. A phrase that straddles a line break matches the
 * paragraph but no single line; that falls back to the record's first line rather
 * than dropping an otherwise valid hit.
 */
function bestLineWithin(
  record: MemoryRecord,
  lines: readonly string[],
  query: ParsedQuery,
): number {
  let bestLine = record.startLine;
  let bestTerms = -1;
  let bestFrequency = -1;

  for (let line = record.startLine; line <= record.endLine; line += 1) {
    const tokens = tokenize(lines[line - 1] ?? "");
    if (tokens.length === 0) continue;
    const normalized = tokens.join(" ");
    if (
      query.phrases.length > 0 &&
      !query.phrases.every((phrase) => matchesPhrase(normalized, phrase))
    ) {
      continue;
    }
    const terms = query.terms.filter(
      (term) => termFrequency(tokens, term) > 0,
    ).length;
    if (terms < bestTerms) continue;
    const frequency = query.terms.reduce(
      (sum, term) => sum + termFrequency(tokens, term),
      0,
    );
    if (terms === bestTerms && frequency <= bestFrequency) continue;
    bestLine = line;
    bestTerms = terms;
    bestFrequency = frequency;
  }

  return bestLine;
}

function excerptFor(
  record: ScoredMemoryRecord,
  lines: readonly string[],
  query: ParsedQuery,
  excerptLines: number,
): MemorySearchEntry {
  const hitLine = bestLineWithin(record, lines, query);
  const startLine = Math.max(1, hitLine - excerptLines);
  const endLine = Math.min(lines.length, hitLine + excerptLines);
  return {
    path: record.path,
    startLine,
    endLine,
    text: lines.slice(startLine - 1, endLine).join("\n"),
    score: record.score,
    placement: record.placement,
  };
}

/**
 * Searches the memory workspace for `query`, best match first.
 *
 * `query` may be a raw string or an already-parsed query. The recall path parses
 * once and shares the terms with the transcript source, so it passes the parsed
 * form: re-parsing a string there would fire the query layer's n-gram expansion a
 * second time and could produce different terms for the two sources.
 *
 * Scoring is the transcript scorer over a different corpus, not a second dialect
 * of it: document frequencies come from every paragraph in the workspace, never
 * from a candidate subset, so a memory hit means the same thing a transcript hit
 * does. An unreadable workspace, an unreadable file, and a query with no terms all
 * return no entries; the caller decides whether that is worth a notice.
 */
export function searchMemoryFiles(
  memoryDir: string,
  query: string | ParsedQuery,
  options: MemorySearchOptions = {},
): MemorySearchResult {
  const stats: MemorySearchStats = {
    files: 0,
    bytes: 0,
    records: 0,
    skippedFiles: 0,
  };
  const parsedQuery = typeof query === "string" ? parseQuery(query) : query;
  if (parsedQuery.terms.length === 0 && parsedQuery.phrases.length === 0) {
    return { entries: [], stats };
  }

  const records: MemoryRecord[] = [];
  const linesByPath = new Map<string, readonly string[]>();
  for (const file of collectRecallFiles(memoryDir)) {
    // The checkpoint the memory source's cost is concentrated in: one
    // `readFileSync` per workspace file.
    if (options.shouldStop?.()) break;
    const document = readMemoryDocument(file, stats);
    if (!document) continue;
    linesByPath.set(file.path, document.lines);
    records.push(...document.records);
  }

  const limit = options.limit ?? MEMORY_SEARCH_DEFAULT_LIMIT;
  const minScore = options.minScore ?? 0;
  const excerptLines = options.excerptLines ?? MEMORY_EXCERPT_LINES;

  const ranked = rankMatches(records, parsedQuery, {
    shouldStop: options.shouldStop,
  })
    .filter((record) => record.score >= minScore)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.path.localeCompare(right.path) ||
        left.startLine - right.startLine,
    )
    .slice(0, Math.max(0, limit));

  return {
    entries: ranked.map((record) =>
      excerptFor(
        record,
        linesByPath.get(record.path) ?? [],
        parsedQuery,
        excerptLines,
      ),
    ),
    stats,
  };
}
