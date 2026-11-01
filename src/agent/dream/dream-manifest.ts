/**
 * Dream memory manifest and defect scan (F-06 / 46-6-Fix-A W2, design §5.10.4
 * and §6.4).
 *
 * Three read-only views of the memory repository feed the dream seed:
 *
 * - {@link listMemoryFiles} — the tracked file list with character/line counts,
 *   filtered to the paths the runtime projects;
 * - {@link recentChanges} — commits since the previous run, with per-file
 *   added/deleted line counts, minus the harness's own report churn;
 * - {@link scanDefects} / {@link defectWeights} — the deterministic findings
 *   (dangling links, missing indexes, oversized files, frontmatter coverage)
 *   that the tidy manual turns into work items.
 *
 * Everything here is evidence, not a gate: nothing is repaired and nothing
 * writes to the repository. Link checking accepts both syntaxes the manual
 * documents (`[[path]]` and `[text](path)`); either one resolving counts as a
 * live link.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DREAM_DIRECTORY_INDEX_FILE_THRESHOLD,
  DREAM_V2_INDEX_FILENAME,
  type DreamLayout,
} from "@/agent/dream/dream-layout";
import { DREAM_REPORT_PATH } from "@/agent/dream/dream-report";
import {
  detectMemoryFormat,
  isProjectedMemoryPath,
} from "@/agent/memory-format";
import { runGit } from "@/agent/memory-git";
import { DEFAULT_MEMORY_CONSTRAINTS_CONFIG } from "@/memory-constraints";

/** Files above this many characters miss the size target, not a hard cap. */
export const DREAM_LARGE_FILE_TARGET_CHARS = 10_000;

/**
 * Calibrate before release (checklist §4): initial per-category weights, applied
 * after each category is normalized so its shares sum to 1.
 */
export const DEFECT_WEIGHTS = {
  missingIndex: 1.0,
  oversized: 1.0,
  brokenLink: 0.5,
} as const;

/** One tracked file that the runtime can project into the memory tree. */
export interface MemoryFileFact {
  /** Repository-relative POSIX path. */
  path: string;
  /** Unicode code points, matching the constraint validator's count. */
  chars: number;
  /** Logical lines; a trailing newline does not add an empty line. */
  lines: number;
  isMarkdown: boolean;
  /** Bytes on disk. */
  size: number;
  /** True when the runtime projects this path (see isProjectedMemoryPath). */
  projected: boolean;
}

export interface ListMemoryFilesOptions {
  /**
   * Include tracked files the runtime does not project (a v2 directory without
   * an index hides its files). Defaults to `false`: the manifest describes the
   * memory the model can actually act on. Defect scanning that must see the
   * whole tracked tree (missing indexes) should pass `true`.
   */
  includeUnprojected?: boolean;
}

export type MemoryFileChangeStatus = "added" | "modified" | "deleted";

export interface MemoryFileChange {
  path: string;
  status: MemoryFileChangeStatus;
  added: number;
  deleted: number;
}

export interface MemoryCommitChange {
  sha: string;
  subject: string;
  files: MemoryFileChange[];
}

export interface MemoryChangeSet {
  /** Previous run's head, or `null` for the first tracked run. */
  sinceSha: string | null;
  headSha: string | null;
  /** True when there is no previous head; the seed renders "first tracked run". */
  firstTracked: boolean;
  commits: MemoryCommitChange[];
  /** Union of changed paths, sorted. */
  paths: string[];
}

export interface BrokenMemoryLink {
  /** File that contains the link. */
  path: string;
  syntax: "wiki" | "markdown";
  /** Target as written in the file. */
  target: string;
  /** 1-based line number of the link. */
  line: number;
}

export interface MissingMemoryIndex {
  /** `""` for the repository root. */
  directory: string;
  /** Index path the format requires. */
  index: string;
}

export interface OversizedMemoryFile {
  path: string;
  chars: number;
  limit: number;
}

export interface FrontmatterCoverage {
  /** Markdown files in scope (index files excluded). */
  total: number;
  withDescription: number;
  missingDescription: string[];
  /** v2 only: non-core, non-index files that should carry `name`. */
  nameRequired: string[];
  withName: number;
  missingName: string[];
}

export interface MemoryDefectScan {
  brokenLinks: BrokenMemoryLink[];
  missingIndexes: MissingMemoryIndex[];
  oversizedFiles: OversizedMemoryFile[];
  /** Files above the 10k target but not necessarily over the hard cap. */
  largeFiles: string[];
  frontmatter: FrontmatterCoverage;
  /** `largeFiles.length / markdown files`; a target, not a defect. */
  largeFileRatio: number;
  totalFiles: number;
}

/** Limits used by {@link scanDefects}; a `DreamLayout["limits"]` fits. */
export interface MemoryDefectLimits {
  /** `null` means the repository sets no cap; omitted means the default cap. */
  maxFileCharacters?: number | null;
}

export interface IndexCoverageEntry {
  /** `""` for the repository root. */
  directory: string;
  /** Markdown files in the directory, excluding its index file. */
  files: number;
  /** Index path checked for this directory. */
  index: string;
  hasIndex: boolean;
  /** v2: every directory; v1: only directories above the file threshold. */
  needsIndex: boolean;
}

export interface MemoryIndexCoverage {
  directories: IndexCoverageEntry[];
  /** Directories that need an index and have one. */
  withIndex: number;
  needsIndex: number;
  /** `withIndex / needsIndex`; `1` when no directory needs an index. */
  coverage: number;
}

const INDEX_FILENAMES = new Set(["MEMORY.md", "INDEX.md"]);

function countCharacters(text: string): number {
  let characters = 0;
  for (const _character of text) characters += 1;
  return characters;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 0;
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) lines += 1;
  }
  return text.endsWith("\n") ? lines : lines + 1;
}

function looksBinary(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, 8_000);
  for (let index = 0; index < limit; index++) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

function normalizeGitPath(path: string): string {
  return path.replaceAll("\\", "/");
}

function isIndexPath(path: string): boolean {
  const slash = path.lastIndexOf("/");
  return INDEX_FILENAMES.has(slash === -1 ? path : path.slice(slash + 1));
}

/**
 * List tracked memory files with character, line and byte counts.
 *
 * Uses `git ls-files -z` through the shared git runner (non-interactive env,
 * `windowsHide`, bounded buffer) so a dream run never opens a console window.
 * Binary files and files the runtime does not project are skipped unless
 * `includeUnprojected` is set.
 */
export async function listMemoryFiles(
  memoryDir: string,
  options: ListMemoryFilesOptions = {},
): Promise<MemoryFileFact[]> {
  const format = detectMemoryFormat(memoryDir, true);
  const listed = (await runGit(memoryDir, ["ls-files", "-z"])).stdout
    .split("\0")
    .map(normalizeGitPath)
    .filter((path) => path.length > 0 && !path.startsWith(".git/"));
  const allPaths = new Set(listed);
  const files: MemoryFileFact[] = [];
  for (const path of listed) {
    const projected = isProjectedMemoryPath(path, allPaths, format);
    if (!projected && options.includeUnprojected !== true) continue;
    let buffer: Buffer;
    try {
      buffer = readFileSync(join(memoryDir, path));
    } catch {
      // Submodules and entries deleted from the working tree are not files.
      continue;
    }
    if (looksBinary(buffer)) continue;
    const text = buffer.toString("utf8");
    files.push({
      path,
      chars: countCharacters(text),
      lines: countLines(text),
      isMarkdown: path.endsWith(".md"),
      size: buffer.length,
      projected,
    });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function splitCommitBlocks(
  stdout: string,
): Array<{ sha: string; subject: string; lines: string[] }> {
  const commits: Array<{ sha: string; subject: string; lines: string[] }> = [];
  for (const block of stdout.split("\x1e")) {
    if (block.length === 0) continue;
    const newline = block.indexOf("\n");
    const header = newline === -1 ? block : block.slice(0, newline);
    const separator = header.indexOf("\x1f");
    if (separator === -1) continue;
    const sha = header.slice(0, separator).trim();
    if (sha.length === 0) continue;
    const subject = header.slice(separator + 1).trim();
    const body = newline === -1 ? "" : block.slice(newline + 1);
    const lines = body
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);
    commits.push({ sha, subject, lines });
  }
  return commits;
}

function statusOf(letter: string): MemoryFileChangeStatus {
  if (letter === "A") return "added";
  if (letter === "D") return "deleted";
  return "modified";
}

/**
 * Commits since the previous run with their changed paths and line counts.
 *
 * Git cannot print `--name-status` and `--numstat` in one pass (one format wins
 * over the other), so the same range is read twice and joined per commit.
 * `--no-renames` keeps numstat paths unambiguous; a rename therefore reads as a
 * delete plus an add. The harness's own `maintenance/dream-report.md` churn and
 * commits that only touch it are dropped (design §5.10.4 item 3).
 */
export async function recentChanges(
  memoryDir: string,
  sinceSha: string | null,
): Promise<MemoryChangeSet> {
  let headSha: string | null = null;
  try {
    headSha =
      (await runGit(memoryDir, ["rev-parse", "HEAD"])).stdout.trim() || null;
  } catch {
    headSha = null;
  }
  if (sinceSha === null || sinceSha.length === 0) {
    return {
      sinceSha: null,
      headSha,
      firstTracked: true,
      commits: [],
      paths: [],
    };
  }
  const range = `${sinceSha}..HEAD`;
  const baseArgs = [
    "-c",
    "core.quotePath=false",
    "log",
    "--no-renames",
    "--format=%x1e%H%x1f%s",
  ];
  const statusOutput = await runGit(memoryDir, [
    ...baseArgs,
    "--name-status",
    range,
  ]);
  const numstatOutput = await runGit(memoryDir, [
    ...baseArgs,
    "--numstat",
    range,
  ]);
  const numbersBySha = new Map<
    string,
    Map<string, { added: number; deleted: number }>
  >();
  for (const commit of splitCommitBlocks(numstatOutput.stdout)) {
    const numbers = new Map<string, { added: number; deleted: number }>();
    for (const line of commit.lines) {
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      const path = normalizeGitPath(parts.slice(2).join("\t"));
      numbers.set(path, {
        added: Number.parseInt(parts[0] ?? "0", 10) || 0,
        deleted: Number.parseInt(parts[1] ?? "0", 10) || 0,
      });
    }
    numbersBySha.set(commit.sha, numbers);
  }
  const commits: MemoryCommitChange[] = [];
  const changedPaths = new Set<string>();
  for (const commit of splitCommitBlocks(statusOutput.stdout)) {
    const numbers = numbersBySha.get(commit.sha);
    const files: MemoryFileChange[] = [];
    for (const line of commit.lines) {
      const parts = line.split("\t");
      if (parts.length < 2) continue;
      const path = normalizeGitPath(parts.slice(1).join("\t"));
      if (path === DREAM_REPORT_PATH) continue;
      const counts = numbers?.get(path);
      files.push({
        path,
        status: statusOf(parts[0] ?? ""),
        added: counts?.added ?? 0,
        deleted: counts?.deleted ?? 0,
      });
    }
    if (files.length === 0) continue;
    for (const file of files) changedPaths.add(file.path);
    commits.push({ sha: commit.sha, subject: commit.subject, files });
  }
  return {
    sinceSha,
    headSha,
    firstTracked: false,
    commits,
    paths: [...changedPaths].sort(),
  };
}

function normalizeCandidate(candidate: string): string | null {
  const segments: string[] = [];
  for (const segment of candidate.replaceAll("\\", "/").split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length === 0 ? null : segments.join("/");
}

function decodeTarget(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isExternalTarget(target: string): boolean {
  const trimmed = target.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) return true;
  if (trimmed.startsWith("//")) return true;
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(trimmed);
}

function linkCandidates(fromPath: string, rawTarget: string): string[] {
  const slash = fromPath.lastIndexOf("/");
  const fromDirectory = slash === -1 ? "" : fromPath.slice(0, slash);
  const trimmed = rawTarget.trim().replace(/^<(.*)>$/u, "$1");
  const withoutAnchor = trimmed.split("#")[0] ?? "";
  const decoded = decodeTarget(withoutAnchor);
  const variants =
    decoded === withoutAnchor ? [withoutAnchor] : [withoutAnchor, decoded];
  const candidates: string[] = [];
  for (const variant of variants) {
    const isAbsolute = variant.startsWith("/");
    const base = isAbsolute ? variant.replace(/^\/+/u, "") : variant;
    const normalizedBase = base.replace(/\/+$/u, "");
    if (normalizedBase.length === 0) continue;
    const relative =
      isAbsolute || fromDirectory.length === 0
        ? normalizedBase
        : `${fromDirectory}/${normalizedBase}`;
    candidates.push(relative, `${relative}.md`);
    if (!isAbsolute && fromDirectory.length > 0) {
      candidates.push(normalizedBase, `${normalizedBase}.md`);
    }
  }
  return candidates;
}

function ancestorDirectories(paths: Iterable<string>): Set<string> {
  const directories = new Set<string>();
  directories.add("");
  for (const path of paths) {
    const parts = path.split("/");
    let current = "";
    for (let index = 0; index < parts.length - 1; index++) {
      current =
        current.length === 0
          ? (parts[index] ?? "")
          : `${current}/${parts[index] ?? ""}`;
      directories.add(current);
    }
  }
  return directories;
}

function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index && cursor < text.length; cursor++) {
    if (text.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

function frontmatterFields(text: string): Map<string, string> | null {
  const lines = text.split(/\r?\n/u);
  if ((lines[0] ?? "").trim() !== "---") return null;
  const fields = new Map<string, string>();
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (line.trim() === "---") return fields;
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    if (key.length === 0) continue;
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^["']|["']$/gu, "");
    fields.set(key, value);
  }
  return null;
}

function readFileText(memoryDir: string, path: string): string | null {
  try {
    return readFileSync(join(memoryDir, path), "utf8");
  } catch {
    return null;
  }
}

function resolveCharacterLimit(config: MemoryDefectLimits): number | null {
  if (config.maxFileCharacters === null) return null;
  if (typeof config.maxFileCharacters === "number") {
    return config.maxFileCharacters;
  }
  return DEFAULT_MEMORY_CONSTRAINTS_CONFIG.maxFileCharacters ?? 20_000;
}

function collectBrokenLinks(
  path: string,
  text: string,
  exists: (candidate: string) => boolean,
): BrokenMemoryLink[] {
  const broken: BrokenMemoryLink[] = [];
  const scan = (
    pattern: RegExp,
    syntax: BrokenMemoryLink["syntax"],
    targetOf: (match: RegExpExecArray) => string,
  ): void => {
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match !== null) {
      const raw = targetOf(match);
      if (!isExternalTarget(raw)) {
        const candidates = linkCandidates(path, raw);
        const live = candidates.some((candidate) => {
          const normalized = normalizeCandidate(candidate);
          return normalized !== null && exists(normalized);
        });
        if (!live) {
          broken.push({
            path,
            syntax,
            target: raw.trim(),
            line: lineNumberAt(text, match.index),
          });
        }
      }
      match = pattern.exec(text);
    }
  };
  scan(/\[\[([^\]\n]+)\]\]/gu, "wiki", (match) => {
    const inner = match[1] ?? "";
    return inner.split("|")[0] ?? "";
  });
  scan(
    /\[[^\]\n]*\]\(([^)\n]+)\)/gu,
    "markdown",
    (match) => (match[1] ?? "").trim().split(/\s+/u)[0] ?? "",
  );
  return broken;
}

/**
 * Scan the manifest for deterministic defects.
 *
 * v2 requires a `MEMORY.md` in every directory; v1 indexes are optional, so
 * missing indexes are only reported for v2. Frontmatter and the >10k share are
 * statistics for the manual, not defects. Pass the full tracked list
 * (`listMemoryFiles(dir, { includeUnprojected: true })`) when missing indexes in
 * unprojected directories matter.
 */
export function scanDefects(
  files: readonly MemoryFileFact[],
  layout: DreamLayout,
  config: MemoryDefectLimits = {},
): MemoryDefectScan {
  const limit = resolveCharacterLimit(config);
  const pathSet = new Set(files.map((file) => file.path));
  const directories = ancestorDirectories(pathSet);
  const exists = (candidate: string): boolean =>
    pathSet.has(candidate) ||
    pathSet.has(`${candidate}.md`) ||
    directories.has(candidate);
  const brokenLinks: BrokenMemoryLink[] = [];
  const oversizedFiles: OversizedMemoryFile[] = [];
  const largeFiles: string[] = [];
  const frontmatter: FrontmatterCoverage = {
    total: 0,
    withDescription: 0,
    missingDescription: [],
    nameRequired: [],
    withName: 0,
    missingName: [],
  };
  let markdownFiles = 0;
  for (const file of files) {
    if (!file.isMarkdown) continue;
    markdownFiles += 1;
    if (file.chars > DREAM_LARGE_FILE_TARGET_CHARS) largeFiles.push(file.path);
    if (limit !== null && file.chars > limit) {
      oversizedFiles.push({ path: file.path, chars: file.chars, limit });
    }
    const text = readFileText(layout.memoryDir, file.path);
    if (text === null) continue;
    brokenLinks.push(...collectBrokenLinks(file.path, text, exists));
    if (isIndexPath(file.path)) continue;
    frontmatter.total += 1;
    const fields = frontmatterFields(text);
    if ((fields?.get("description") ?? "").length > 0) {
      frontmatter.withDescription += 1;
    } else {
      frontmatter.missingDescription.push(file.path);
    }
    const nameNeeded = layout.format === "memfs-v2" && file.path.includes("/");
    if (!nameNeeded) continue;
    frontmatter.nameRequired.push(file.path);
    if ((fields?.get("name") ?? "").length > 0) {
      frontmatter.withName += 1;
    } else {
      frontmatter.missingName.push(file.path);
    }
  }
  const missingIndexes: MissingMemoryIndex[] = [];
  if (layout.index.required) {
    for (const directory of [...directories].sort()) {
      const index =
        directory.length === 0
          ? DREAM_V2_INDEX_FILENAME
          : `${directory}/${DREAM_V2_INDEX_FILENAME}`;
      if (!pathSet.has(index)) missingIndexes.push({ directory, index });
    }
  }
  return {
    brokenLinks,
    missingIndexes,
    oversizedFiles,
    largeFiles: largeFiles.sort(),
    frontmatter,
    largeFileRatio: markdownFiles === 0 ? 0 : largeFiles.length / markdownFiles,
    totalFiles: files.length,
  };
}

/**
 * Per-file defect score: each category is normalized so its shares sum to 1,
 * then multiplied by {@link DEFECT_WEIGHTS}. A missing index is attributed to
 * the index file that should exist; a dangling link to the file containing it.
 */
export function defectWeights(
  defects: MemoryDefectScan,
): Record<string, number> {
  const scores = new Map<string, number>();
  const add = (path: string, weight: number, share: number): void => {
    if (path.length === 0 || share === 0) return;
    scores.set(path, (scores.get(path) ?? 0) + weight * share);
  };
  const linkCounts = new Map<string, number>();
  for (const link of defects.brokenLinks) {
    linkCounts.set(link.path, (linkCounts.get(link.path) ?? 0) + 1);
  }
  for (const [path, count] of linkCounts) {
    add(path, DEFECT_WEIGHTS.brokenLink, count / defects.brokenLinks.length);
  }
  for (const file of defects.oversizedFiles) {
    add(file.path, DEFECT_WEIGHTS.oversized, 1 / defects.oversizedFiles.length);
  }
  for (const missing of defects.missingIndexes) {
    add(
      missing.index,
      DEFECT_WEIGHTS.missingIndex,
      1 / defects.missingIndexes.length,
    );
  }
  return Object.fromEntries(
    [...scores.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

/** Per-directory file counts and index presence, for the manual's S2 step. */
export function indexCoverage(
  files: readonly MemoryFileFact[],
  layout: DreamLayout,
): MemoryIndexCoverage {
  const counts = new Map<string, number>();
  const present = new Set<string>();
  for (const file of files) {
    if (!file.isMarkdown) continue;
    const slash = file.path.lastIndexOf("/");
    const directory = slash === -1 ? "" : file.path.slice(0, slash);
    if (isIndexPath(file.path)) {
      present.add(directory);
      continue;
    }
    counts.set(directory, (counts.get(directory) ?? 0) + 1);
  }
  const directories = [...new Set([...counts.keys(), ...present])].sort(
    (left, right) => left.localeCompare(right),
  );
  const entries: IndexCoverageEntry[] = [];
  let withIndex = 0;
  let needsIndex = 0;
  for (const directory of directories) {
    const count = counts.get(directory) ?? 0;
    const needs = layout.index.required
      ? true
      : count > DREAM_DIRECTORY_INDEX_FILE_THRESHOLD;
    const hasIndex = present.has(directory);
    if (needs && hasIndex) withIndex += 1;
    if (needs) needsIndex += 1;
    entries.push({
      directory,
      files: count,
      index:
        directory.length === 0
          ? layout.index.rootIndexPath
          : `${directory}/${DREAM_V2_INDEX_FILENAME}`,
      hasIndex,
      needsIndex: needs,
    });
  }
  return {
    directories: entries,
    withIndex,
    needsIndex,
    coverage: needsIndex === 0 ? 1 : withIndex / needsIndex,
  };
}
