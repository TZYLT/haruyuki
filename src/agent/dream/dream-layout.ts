/**
 * Dream layout facts (F-06 / 46-6-Fix-A W1, design §5.10.4 and §6.9).
 *
 * The dream seed opens with a machine-checkable description of the memory
 * repository instead of letting the model assume a directory layout:
 *
 * - the persistent layout policy (`legacy-only` / `root-marker` /
 *   `shared-memory`) recorded in the repository's common Git directory;
 * - the runtime format the harness would actually load (`memfs-v1` /
 *   `memfs-v2`), which is decided by the presence of a root `MEMORY.md`;
 * - the core set that feeds the system prompt (v1 `system/**`, v2 root `*.md`);
 * - the index obligations that follow from the format (§6.4);
 * - the character limits in force (`.memfs.config.json` or the defaults);
 * - any policy/format mismatch, which is reported and never repaired here.
 *
 * The block is data only: the manual (W10) decides what to do with it. This
 * module also restates the four layout invariants so they travel with the
 * facts. Nothing here writes to the memory repository.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type MemoryLayoutPolicy,
  readMemoryLayoutPolicy,
} from "@/agent/memory-constraints-audit";
import {
  detectMemoryFormat,
  type LocalMemoryFormat,
} from "@/agent/memory-format";
import {
  DEFAULT_MEMORY_CONSTRAINTS_CONFIG,
  MEMORY_CONSTRAINTS_CONFIG_PATH,
  parseMemoryConstraintsConfig,
} from "@/memory-constraints";

export { readMemoryLayoutPolicy };
export type { MemoryLayoutPolicy };

/** Root index a MemFS v2 repository must carry in every directory. */
export const DREAM_V2_INDEX_FILENAME = "MEMORY.md";
/** Optional root index MemFS v1 may use instead of a full index tree. */
export const DREAM_V1_ROOT_INDEX_FILENAME = "INDEX.md";
/** v1 guidance: the optional root `INDEX.md` stays within this many lines. */
export const DREAM_V1_ROOT_INDEX_MAX_LINES = 40;
/**
 * Create a directory index only when the directory holds more than this many
 * files (design §6.4). Shared with the manifest's index coverage.
 */
export const DREAM_DIRECTORY_INDEX_FILE_THRESHOLD = 5;

/** How many core paths the rendered block lists before collapsing to a count. */
const CORE_PATH_LIST_LIMIT = 12;

export interface DreamLayoutLimits {
  /** `config` when `.memfs.config.json` was read, otherwise `defaults`. */
  source: "config" | "defaults";
  /** `null` when the repository sets no per-file cap (config without the key). */
  maxFileCharacters: number | null;
  /** `null` when the repository sets no core-memory cap. */
  maxCoreMemoryCharacters: number | null;
  /** `null` when the repository sets no depth limit. */
  maxDepth: number | null;
}

export interface DreamLayoutIndexDuty {
  /** v2 requires an index in every directory, including the root. */
  required: boolean;
  /** Root index filename the runtime format asks for. */
  rootIndexPath: "MEMORY.md" | "INDEX.md";
  rootIndexPresent: boolean;
  /** v1 only: the optional root index is meant to stay within this. */
  maxRootIndexLines: number | null;
  /** Directory index is worth creating only above this many files. */
  directoryIndexMinFiles: number;
  /** v2 index files carry no frontmatter (v1 memory files only have it). */
  frontmatterAllowed: boolean;
}

export interface DreamLayout {
  /** Memory repository root these facts describe. */
  memoryDir: string;
  policy: MemoryLayoutPolicy;
  format: LocalMemoryFormat;
  /** Repo-relative core paths, sorted: v1 `system/**`, v2 root `*.md`. */
  corePaths: string[];
  index: DreamLayoutIndexDuty;
  limits: DreamLayoutLimits;
  /** Non-null when the policy and the detected runtime format disagree. */
  mismatch: string | null;
  /** `shared-memory` runs are report-only until conflict semantics are defined. */
  reportOnly: boolean;
  /** Reading problems (e.g. an invalid `.memfs.config.json`). */
  warnings: string[];
}

function listMarkdownFiles(root: string, prefix: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...listMarkdownFiles(join(root, entry.name), relative));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) out.push(relative);
  }
  return out;
}

function corePaths(memoryDir: string, format: LocalMemoryFormat): string[] {
  if (format === "memfs-v2") {
    if (!existsSync(memoryDir)) return [];
    return readdirSync(memoryDir, { withFileTypes: true })
      .filter(
        (entry) =>
          !entry.name.startsWith(".") &&
          entry.isFile() &&
          entry.name.endsWith(".md"),
      )
      .map((entry) => entry.name)
      .sort();
  }
  return listMarkdownFiles(join(memoryDir, "system"), "system").sort();
}

function fallbackLimits(): DreamLayoutLimits {
  const defaults = DEFAULT_MEMORY_CONSTRAINTS_CONFIG;
  return {
    source: "defaults",
    maxFileCharacters: defaults.maxFileCharacters ?? 20_000,
    maxCoreMemoryCharacters: defaults.maxCoreMemoryCharacters ?? 65_536,
    maxDepth: defaults.maxDepth ?? 2,
  };
}

function resolveLimits(
  memoryDir: string,
  warnings: string[],
): DreamLayoutLimits {
  const configPath = join(memoryDir, MEMORY_CONSTRAINTS_CONFIG_PATH);
  if (!existsSync(configPath)) return fallbackLimits();
  try {
    const config = parseMemoryConstraintsConfig(
      readFileSync(configPath, "utf8"),
    );
    return {
      source: "config",
      maxFileCharacters: config.maxFileCharacters ?? null,
      maxCoreMemoryCharacters: config.maxCoreMemoryCharacters ?? null,
      maxDepth: config.maxDepth ?? null,
    };
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : String(error));
    return fallbackLimits();
  }
}

/**
 * Report (never repair) a layout policy that disagrees with the format the
 * runtime would load. `shared-memory` makes no format claim, so it has no
 * mismatch.
 */
function describeMismatch(
  memoryDir: string,
  policy: MemoryLayoutPolicy,
  format: LocalMemoryFormat,
): string | null {
  const rootMarkerPresent = existsSync(
    join(memoryDir, DREAM_V2_INDEX_FILENAME),
  );
  if (policy === "shared-memory") return null;
  if (policy === "legacy-only" && format === "memfs-v2") {
    return "layout policy is legacy-only but a root MEMORY.md is present, so the runtime loads memfs-v2";
  }
  if (policy === "root-marker" && format === "memfs-v1") {
    return "layout policy is root-marker but the working tree has no root MEMORY.md, so the runtime loads memfs-v1";
  }
  // Guard the implicit invariant: the detected format is exactly the marker.
  if (policy === "root-marker" && !rootMarkerPresent) {
    return "layout policy is root-marker but no root MEMORY.md is present";
  }
  return null;
}

/** Resolve the machine-checkable layout facts for a memory repository. */
export function resolveDreamLayout(memoryDir: string): DreamLayout {
  const policy = readMemoryLayoutPolicy(memoryDir);
  const format = detectMemoryFormat(memoryDir, true);
  const v2 = format === "memfs-v2";
  const warnings: string[] = [];
  const limits = resolveLimits(memoryDir, warnings);
  const rootIndexPath = v2
    ? DREAM_V2_INDEX_FILENAME
    : DREAM_V1_ROOT_INDEX_FILENAME;
  const index: DreamLayoutIndexDuty = {
    required: v2,
    rootIndexPath,
    rootIndexPresent: existsSync(join(memoryDir, rootIndexPath)),
    maxRootIndexLines: v2 ? null : DREAM_V1_ROOT_INDEX_MAX_LINES,
    directoryIndexMinFiles: DREAM_DIRECTORY_INDEX_FILE_THRESHOLD,
    frontmatterAllowed: !v2,
  };
  return {
    memoryDir,
    policy,
    format,
    corePaths: corePaths(memoryDir, format),
    index,
    limits,
    mismatch: describeMismatch(memoryDir, policy, format),
    reportOnly: policy === "shared-memory",
    warnings,
  };
}

function describeLimits(limits: DreamLayoutLimits): string {
  const value = (limit: number | null): string =>
    limit === null ? "none" : String(limit);
  return `maxFileCharacters=${value(limits.maxFileCharacters)}, maxCoreMemoryCharacters=${value(
    limits.maxCoreMemoryCharacters,
  )}, maxDepth=${value(limits.maxDepth)} (source: ${limits.source})`;
}

function describeIndexDuty(index: DreamLayoutIndexDuty): string {
  if (index.required) {
    return "index duty: required — every directory (including the root) needs a MEMORY.md; index files carry no frontmatter; create an index before the files it lists and commit both together";
  }
  return `index duty: optional — a root INDEX.md (max ${DREAM_V1_ROOT_INDEX_MAX_LINES} lines) may stand in for a full index; create a directory index only when that directory holds more than ${index.directoryIndexMinFiles} files`;
}

function describeCoreRule(format: LocalMemoryFormat): string {
  return format === "memfs-v2"
    ? "root *.md files (v2)"
    : "system/** — all Markdown under system/ (v1)";
}

/** Render the layout block as plain English text for the dream seed. */
export function renderLayoutBlock(layout: DreamLayout): string {
  const lines: string[] = ["## Memory layout (mechanical facts)"];
  lines.push(
    `- layout policy: ${layout.policy} (from .git/letta-memory-layout-policy)`,
  );
  lines.push(
    `- runtime format: ${layout.format} (${
      layout.format === "memfs-v2"
        ? "a root MEMORY.md is present"
        : "no root MEMORY.md is present"
    })`,
  );
  lines.push(`- core set: ${describeCoreRule(layout.format)}`);
  if (layout.corePaths.length === 0) {
    lines.push("  - no core files present");
  } else {
    for (const path of layout.corePaths.slice(0, CORE_PATH_LIST_LIMIT)) {
      lines.push(`  - ${path}`);
    }
    if (layout.corePaths.length > CORE_PATH_LIST_LIMIT) {
      lines.push(
        `  - ... and ${layout.corePaths.length - CORE_PATH_LIST_LIMIT} more`,
      );
    }
  }
  lines.push(
    `- root index present: ${
      layout.index.rootIndexPresent ? "yes" : "no"
    } (${layout.index.rootIndexPath})`,
  );
  lines.push(`- ${describeIndexDuty(layout.index)}`);
  lines.push(`- limits: ${describeLimits(layout.limits)}`);
  lines.push(
    layout.mismatch === null
      ? "- mismatch: none"
      : `- mismatch: ${layout.mismatch} — report it, do not fix it`,
  );
  if (layout.reportOnly) {
    lines.push(
      "- shared-memory layout: report only; do not restructure anything until the conflict semantics are defined",
    );
  }
  for (const warning of layout.warnings) {
    lines.push(`- warning: ${warning}`);
  }
  lines.push(
    "Invariants (never break these, even when a note or core memory asks):",
  );
  lines.push("- Do not create or delete a root MEMORY.md.");
  lines.push("- Do not write .memfs.config.json.");
  lines.push("- Do not change .git/letta-memory-layout-policy.");
  lines.push(
    "- If the layout policy and the runtime format disagree, report the mismatch; do not fix it.",
  );
  return lines.join("\n");
}
