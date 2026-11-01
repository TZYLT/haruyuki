import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DREAM_V1_ROOT_INDEX_MAX_LINES,
  readMemoryLayoutPolicy,
  renderLayoutBlock,
  resolveDreamLayout,
} from "@/agent/dream/dream-layout";
import {
  createTempGitRepo,
  type TempGitRepo,
} from "@/test-utils/temp-git-repo";

const repos: TempGitRepo[] = [];
const dirs: string[] = [];

function newRepo(prefix: string): TempGitRepo {
  const repo = createTempGitRepo(prefix);
  repos.push(repo);
  return repo;
}

function newDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function write(dir: string, relativePath: string, content: string): void {
  const full = join(dir, relativePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
}

function writePolicy(repo: TempGitRepo, policy: string): void {
  write(repo.dir, join(".git", "letta-memory-layout-policy"), policy);
}

function commitAll(repo: TempGitRepo, message: string): void {
  repo.git("add", ".");
  repo.git("commit", "-qm", message);
}

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("resolveDreamLayout", () => {
  test("describes a legacy-only v1 repository", () => {
    const repo = newRepo("dream-layout-v1-");
    writePolicy(repo, "legacy-only");
    write(repo.dir, "system/persona.md", "# Persona\n");
    write(repo.dir, "system/project/notes.md", "# Notes\n");
    write(repo.dir, "notes.md", "# Root note\n");
    commitAll(repo, "initial memory");

    const layout = resolveDreamLayout(repo.dir);

    expect(layout.policy).toBe("legacy-only");
    expect(layout.format).toBe("memfs-v1");
    expect(layout.corePaths).toEqual([
      "system/persona.md",
      "system/project/notes.md",
    ]);
    expect(layout.index).toEqual({
      required: false,
      rootIndexPath: "INDEX.md",
      rootIndexPresent: false,
      maxRootIndexLines: DREAM_V1_ROOT_INDEX_MAX_LINES,
      directoryIndexMinFiles: 5,
      frontmatterAllowed: true,
    });
    expect(layout.limits).toEqual({
      source: "defaults",
      maxFileCharacters: 20_000,
      maxCoreMemoryCharacters: 65_536,
      maxDepth: 2,
    });
    expect(layout.mismatch).toBeNull();
    expect(layout.reportOnly).toBe(false);
    expect(layout.warnings).toEqual([]);

    const block = renderLayoutBlock(layout);
    expect(block).toStartWith("## Memory layout (mechanical facts)");
    expect(block).toContain("- layout policy: legacy-only");
    expect(block).toContain("- runtime format: memfs-v1");
    expect(block).toContain("system/**");
    expect(block).toContain("system/project/notes.md");
    expect(block).toContain("- root index present: no (INDEX.md)");
    expect(block).toContain("index duty: optional");
    expect(block).toContain("maxFileCharacters=20000");
    expect(block).toContain("- mismatch: none");
    expect(block).toContain("- Do not create or delete a root MEMORY.md.");
    expect(block).toContain("- Do not write .memfs.config.json.");
    expect(block).toContain("- Do not change .git/letta-memory-layout-policy.");
    expect(block).toContain("report the mismatch; do not fix it");
  });

  test("describes a root-marker v2 repository", () => {
    const repo = newRepo("dream-layout-v2-");
    writePolicy(repo, "root-marker");
    write(repo.dir, "MEMORY.md", "# Memory index\n");
    write(repo.dir, "persona.md", "# Persona\n");
    write(repo.dir, "reference/MEMORY.md", "# Reference\n");
    write(repo.dir, "reference/topic.md", "# Topic\n");
    commitAll(repo, "initial memory");

    const layout = resolveDreamLayout(repo.dir);

    expect(readMemoryLayoutPolicy(repo.dir)).toBe("root-marker");
    expect(layout.policy).toBe("root-marker");
    expect(layout.format).toBe("memfs-v2");
    expect(layout.corePaths).toEqual(["MEMORY.md", "persona.md"]);
    expect(layout.index).toEqual({
      required: true,
      rootIndexPath: "MEMORY.md",
      rootIndexPresent: true,
      maxRootIndexLines: null,
      directoryIndexMinFiles: 5,
      frontmatterAllowed: false,
    });
    expect(layout.mismatch).toBeNull();

    const block = renderLayoutBlock(layout);
    expect(block).toContain("- runtime format: memfs-v2");
    expect(block).toContain("root *.md files");
    expect(block).toContain("- root index present: yes (MEMORY.md)");
    expect(block).toContain("index duty: required");
    expect(block).toContain("carry no frontmatter");
  });

  test("treats root-marker as legacy-only until a MEMORY.md history exists", () => {
    const repo = newRepo("dream-layout-root-marker-");
    writePolicy(repo, "root-marker");
    // The policy names root-marker, but no commit ever carried a root
    // MEMORY.md, so the same fallback as the commit-time audit applies.
    write(repo.dir, "system/persona.md", "# Persona\n");
    commitAll(repo, "legacy memory");

    expect(readMemoryLayoutPolicy(repo.dir)).toBe("legacy-only");
    const layout = resolveDreamLayout(repo.dir);
    expect(layout.policy).toBe("legacy-only");
    expect(layout.format).toBe("memfs-v1");
    expect(layout.mismatch).toBeNull();
  });

  test("marks a shared-memory layout as report-only", () => {
    const repo = newRepo("dream-layout-shared-");
    writePolicy(repo, "shared-memory");
    write(repo.dir, "system/persona.md", "# Persona\n");
    commitAll(repo, "initial memory");

    const layout = resolveDreamLayout(repo.dir);

    expect(layout.policy).toBe("shared-memory");
    expect(layout.format).toBe("memfs-v1");
    expect(layout.reportOnly).toBe(true);
    expect(layout.mismatch).toBeNull();
    expect(renderLayoutBlock(layout)).toContain(
      "shared-memory layout: report only",
    );
  });

  test("reports a policy/format mismatch without repairing it", () => {
    const repo = newRepo("dream-layout-mismatch-");
    writePolicy(repo, "legacy-only");
    write(repo.dir, "MEMORY.md", "# Memory index\n");
    write(repo.dir, "persona.md", "# Persona\n");
    commitAll(repo, "initial memory");

    const layout = resolveDreamLayout(repo.dir);

    expect(layout.policy).toBe("legacy-only");
    expect(layout.format).toBe("memfs-v2");
    expect(layout.mismatch).toContain("legacy-only");
    expect(layout.mismatch).toContain("memfs-v2");
    const block = renderLayoutBlock(layout);
    expect(block).toContain("- mismatch: layout policy is legacy-only");
    expect(block).toContain("report it, do not fix it");
    // Resolving layout facts is read-only: the repository is untouched.
    expect(repo.git("status", "--porcelain")).toBe("");
  });

  test("reads custom limits from .memfs.config.json and warns on an invalid one", () => {
    const configured = newRepo("dream-layout-config-");
    writePolicy(configured, "legacy-only");
    write(configured.dir, "system/persona.md", "# Persona\n");
    write(
      configured.dir,
      ".memfs.config.json",
      JSON.stringify({
        version: 1,
        maxFileCharacters: 5_000,
        maxCoreMemoryCharacters: 30_000,
        maxDepth: 3,
      }),
    );
    commitAll(configured, "initial memory");

    const layout = resolveDreamLayout(configured.dir);
    expect(layout.limits).toEqual({
      source: "config",
      maxFileCharacters: 5_000,
      maxCoreMemoryCharacters: 30_000,
      maxDepth: 3,
    });
    expect(layout.warnings).toEqual([]);
    expect(renderLayoutBlock(layout)).toContain("(source: config)");

    const broken = newRepo("dream-layout-bad-config-");
    writePolicy(broken, "legacy-only");
    write(broken.dir, ".memfs.config.json", "{ not json");
    const brokenLayout = resolveDreamLayout(broken.dir);
    expect(brokenLayout.limits.source).toBe("defaults");
    expect(brokenLayout.warnings).toHaveLength(1);
    expect(brokenLayout.warnings[0]).toContain(".memfs.config.json");
    expect(renderLayoutBlock(brokenLayout)).toContain("- warning:");
  });

  test("falls back to the default limits without a config file", () => {
    const repo = newRepo("dream-layout-no-config-");
    writePolicy(repo, "legacy-only");
    write(repo.dir, "system/persona.md", "# Persona\n");
    commitAll(repo, "initial memory");

    const layout = resolveDreamLayout(repo.dir);
    expect(layout.limits.source).toBe("defaults");
    expect(layout.limits.maxFileCharacters).toBe(20_000);
    expect(layout.limits.maxCoreMemoryCharacters).toBe(65_536);
    expect(layout.limits.maxDepth).toBe(2);
  });

  test("describes an empty directory as legacy-only v1 with no core files", () => {
    const dir = newDir("dream-layout-empty-");

    const layout = resolveDreamLayout(dir);

    expect(layout.policy).toBe("legacy-only");
    expect(layout.format).toBe("memfs-v1");
    expect(layout.corePaths).toEqual([]);
    expect(layout.index.rootIndexPresent).toBe(false);
    expect(layout.mismatch).toBeNull();
    const block = renderLayoutBlock(layout);
    expect(block).toContain("- core set: system/**");
    expect(block).toContain("no core files present");
    expect(block).toContain("- limits: maxFileCharacters=20000");
  });
});
