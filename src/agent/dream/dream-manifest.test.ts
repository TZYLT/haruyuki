import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveDreamLayout } from "@/agent/dream/dream-layout";
import {
  DEFECT_WEIGHTS,
  defectWeights,
  indexCoverage,
  listMemoryFiles,
  recentChanges,
  scanDefects,
} from "@/agent/dream/dream-manifest";
import { DREAM_REPORT_PATH } from "@/agent/dream/dream-report";
import {
  createTempGitRepo,
  type TempGitRepo,
} from "@/test-utils/temp-git-repo";

const repos: TempGitRepo[] = [];

function newRepo(prefix: string): TempGitRepo {
  const repo = createTempGitRepo(prefix);
  repos.push(repo);
  return repo;
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

function commitFile(
  repo: TempGitRepo,
  relativePath: string,
  content: string,
  message: string,
): string {
  write(repo.dir, relativePath, content);
  commitAll(repo, message);
  return repo.git("rev-parse", "HEAD");
}

/** `lines` lines of `characters`-ish text, deterministic and markdown-ish. */
function markdownOfLines(lines: number): string {
  return `${Array.from({ length: lines }, (_, index) => `line ${index}\n`).join("")}`;
}

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup();
});

describe("listMemoryFiles", () => {
  test("lists tracked v1 memory files with counts and skips binary files", async () => {
    const repo = newRepo("dream-manifest-list-");
    writePolicy(repo, "legacy-only");
    write(repo.dir, "system/a.md", "# A\n");
    write(repo.dir, "system/project/notes.md", "# Notes\n");
    write(repo.dir, "notes.md", "# Root\n");
    write(repo.dir, ".memfs.config.json", '{"version":1}\n');
    const binary = join(repo.dir, "image.png");
    writeFileSync(binary, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    commitAll(repo, "initial memory");

    const files = await listMemoryFiles(repo.dir);
    const paths = files.map((file) => file.path);

    expect(paths).toEqual([
      ".memfs.config.json",
      "notes.md",
      "system/a.md",
      "system/project/notes.md",
    ]);
    const entry = files.find((file) => file.path === "system/a.md");
    expect(entry).toEqual({
      path: "system/a.md",
      chars: 4,
      lines: 1,
      isMarkdown: true,
      size: 4,
      projected: true,
    });
    expect(files.find((file) => file.path === "notes.md")?.isMarkdown).toBe(
      true,
    );
    expect(
      files.find((file) => file.path === ".memfs.config.json")?.isMarkdown,
    ).toBe(false);
  });

  test("filters v2 files the runtime does not project", async () => {
    const repo = newRepo("dream-manifest-projected-");
    writePolicy(repo, "root-marker");
    write(repo.dir, "MEMORY.md", "# Index\n");
    write(repo.dir, "reference/MEMORY.md", "# Reference\n");
    write(repo.dir, "reference/topic.md", "# Topic\n");
    write(repo.dir, "stray/orphan.md", "# Orphan\n");
    write(repo.dir, "skills/demo/SKILL.md", "# Skill\n");
    commitAll(repo, "initial memory");

    const projected = await listMemoryFiles(repo.dir);
    expect(projected.map((file) => file.path)).toEqual([
      "MEMORY.md",
      "reference/MEMORY.md",
      "reference/topic.md",
    ]);
    expect(projected.every((file) => file.projected)).toBe(true);

    const all = await listMemoryFiles(repo.dir, { includeUnprojected: true });
    expect(all.map((file) => file.path)).toEqual([
      "MEMORY.md",
      "reference/MEMORY.md",
      "reference/topic.md",
      "skills/demo/SKILL.md",
      "stray/orphan.md",
    ]);
    expect(all.find((file) => file.path === "stray/orphan.md")?.projected).toBe(
      false,
    );
  });
});

describe("recentChanges", () => {
  test("reports commits and paths since the previous head without report churn", async () => {
    const repo = newRepo("dream-manifest-changes-");
    writePolicy(repo, "legacy-only");
    const base = commitFile(repo, "system/a.md", "one\ntwo\n", "first");
    commitFile(repo, "system/a.md", "one\ntwo\nthree\nfour\n", "extend a");
    write(repo.dir, "system/b.md", "b\n");
    commitAll(repo, "add b");
    commitFile(
      repo,
      DREAM_REPORT_PATH,
      "---\nname: Dream report\ndescription: report\n---\nreport\n",
      "report only",
    );
    write(repo.dir, DREAM_REPORT_PATH, "---\ndescription: report\n---\nnew\n");
    write(repo.dir, "system/a.md", "one\ntwo\nthree\nfour\nfive\n");
    commitAll(repo, "report plus a real change");

    const changes = await recentChanges(repo.dir, base);

    expect(changes.firstTracked).toBe(false);
    expect(changes.sinceSha).toBe(base);
    expect(changes.headSha).toBe(repo.git("rev-parse", "HEAD"));
    expect(changes.commits.map((commit) => commit.subject)).toEqual([
      "report plus a real change",
      "add b",
      "extend a",
    ]);
    const reportOnlyPath = changes.commits.flatMap((commit) =>
      commit.files.map((file) => file.path),
    );
    expect(reportOnlyPath).not.toContain(DREAM_REPORT_PATH);
    const extend = changes.commits.find(
      (commit) => commit.subject === "extend a",
    );
    expect(extend?.files).toEqual([
      {
        path: "system/a.md",
        status: "modified",
        added: 2,
        deleted: 0,
      },
    ]);
    expect(changes.paths).toEqual(["system/a.md", "system/b.md"]);
  });

  test("reports a first tracked run without a previous head", async () => {
    const repo = newRepo("dream-manifest-first-");
    writePolicy(repo, "legacy-only");
    commitFile(repo, "system/a.md", "one\n", "first");

    const changes = await recentChanges(repo.dir, null);
    expect(changes.firstTracked).toBe(true);
    expect(changes.commits).toEqual([]);
    expect(changes.paths).toEqual([]);
    expect(changes.headSha).toBe(repo.git("rev-parse", "HEAD"));
  });

  test("keeps non-ASCII paths readable in both the manifest and changes", async () => {
    const repo = newRepo("dream-manifest-unicode-");
    writePolicy(repo, "legacy-only");
    const base = commitFile(repo, "system/基线.md", "初始\n", "初始提交");
    commitFile(repo, "system/记忆.md", "# 记忆\n", "新增记忆");

    const files = await listMemoryFiles(repo.dir);
    expect(files.map((file) => file.path)).toContain("system/记忆.md");

    const changes = await recentChanges(repo.dir, base);
    expect(changes.paths).toEqual(["system/记忆.md"]);
  });
});

describe("scanDefects", () => {
  test("accepts both link syntaxes and reports only dangling targets", async () => {
    const repo = newRepo("dream-manifest-links-");
    writePolicy(repo, "legacy-only");
    write(repo.dir, "system/notes.md", "# Notes\n");
    write(repo.dir, "reference/topic.md", "# Topic\n");
    write(
      repo.dir,
      "system/persona.md",
      [
        "See [[notes]] and [topic](../reference/topic.md).",
        "Dangling: [[missing-file]] and [gone](missing.md).",
        "External: [site](https://example.com), [[#anchor]] and [mail](mailto:a@b.c).",
        "",
      ].join("\n"),
    );
    commitAll(repo, "initial memory");

    const layout = resolveDreamLayout(repo.dir);
    const files = await listMemoryFiles(repo.dir);
    const defects = scanDefects(files, layout);

    expect(
      defects.brokenLinks.map((link) => `${link.syntax}:${link.target}`),
    ).toEqual(["wiki:missing-file", "markdown:missing.md"]);
    expect(defects.brokenLinks[0]?.path).toBe("system/persona.md");
    expect(defects.brokenLinks[0]?.line).toBe(2);
    expect(defects.brokenLinks[1]?.line).toBe(2);
  });

  test("reports missing indexes for v2 only", async () => {
    const v2 = newRepo("dream-manifest-index-v2-");
    writePolicy(v2, "root-marker");
    write(v2.dir, "MEMORY.md", "# Index\n");
    write(v2.dir, "a/entry.md", "# Entry\n");
    commitAll(v2, "initial memory");
    const v2Layout = resolveDreamLayout(v2.dir);
    const v2Files = await listMemoryFiles(v2.dir, {
      includeUnprojected: true,
    });
    expect(scanDefects(v2Files, v2Layout).missingIndexes).toEqual([
      { directory: "a", index: "a/MEMORY.md" },
    ]);

    const v1 = newRepo("dream-manifest-index-v1-");
    writePolicy(v1, "legacy-only");
    write(v1.dir, "system/a.md", "# A\n");
    commitAll(v1, "initial memory");
    const v1Layout = resolveDreamLayout(v1.dir);
    const v1Files = await listMemoryFiles(v1.dir);
    expect(scanDefects(v1Files, v1Layout).missingIndexes).toEqual([]);
  });

  test("flags files above the cap and counts the >10k share", async () => {
    const repo = newRepo("dream-manifest-oversized-");
    writePolicy(repo, "legacy-only");
    write(repo.dir, "system/huge.md", markdownOfLines(3_000));
    write(repo.dir, "system/large.md", markdownOfLines(1_300));
    write(repo.dir, "system/small.md", "# Small\n");
    commitAll(repo, "initial memory");

    const layout = resolveDreamLayout(repo.dir);
    const files = await listMemoryFiles(repo.dir);
    const defects = scanDefects(files, layout);

    expect(defects.oversizedFiles).toHaveLength(1);
    expect(defects.oversizedFiles[0]?.path).toBe("system/huge.md");
    expect(defects.oversizedFiles[0]?.limit).toBe(20_000);
    expect(defects.oversizedFiles[0]?.chars).toBe(
      files.find((file) => file.path === "system/huge.md")?.chars,
    );
    expect(defects.largeFiles).toEqual(["system/huge.md", "system/large.md"]);
    expect(defects.largeFileRatio).toBeCloseTo(2 / 3, 5);

    const custom = scanDefects(files, layout, { maxFileCharacters: 100_000 });
    expect(custom.oversizedFiles).toEqual([]);
    const uncapped = scanDefects(files, layout, { maxFileCharacters: null });
    expect(uncapped.oversizedFiles).toEqual([]);
  });

  test("reports frontmatter coverage as statistics, not defects", async () => {
    const repo = newRepo("dream-manifest-frontmatter-");
    writePolicy(repo, "root-marker");
    write(repo.dir, "MEMORY.md", "# Index\n");
    write(
      repo.dir,
      "persona.md",
      "---\ndescription: Identity\n---\n# Persona\n",
    );
    write(repo.dir, "reference/MEMORY.md", "# Reference\n");
    write(
      repo.dir,
      "reference/topic.md",
      "---\ndescription: Topic\n---\n# Topic\n",
    );
    write(repo.dir, "reference/bare.md", "# Bare\n");
    commitAll(repo, "initial memory");

    const layout = resolveDreamLayout(repo.dir);
    const files = await listMemoryFiles(repo.dir);
    const defects = scanDefects(files, layout);
    const frontmatter = defects.frontmatter;

    expect(frontmatter.total).toBe(3);
    expect(frontmatter.withDescription).toBe(2);
    expect(frontmatter.missingDescription).toEqual(["reference/bare.md"]);
    expect(frontmatter.nameRequired).toEqual([
      "reference/bare.md",
      "reference/topic.md",
    ]);
    expect(frontmatter.withName).toBe(0);
    expect(frontmatter.missingName).toEqual([
      "reference/bare.md",
      "reference/topic.md",
    ]);
  });
});

describe("defectWeights", () => {
  test("normalizes each defect category before applying the weights", () => {
    const defects = {
      brokenLinks: [
        { path: "a.md", syntax: "wiki" as const, target: "x", line: 1 },
        { path: "a.md", syntax: "wiki" as const, target: "y", line: 2 },
        { path: "b.md", syntax: "markdown" as const, target: "z", line: 1 },
      ],
      missingIndexes: [{ directory: "d", index: "d/MEMORY.md" }],
      oversizedFiles: [{ path: "a.md", chars: 30_000, limit: 20_000 }],
      largeFiles: ["a.md"],
      frontmatter: {
        total: 2,
        withDescription: 2,
        missingDescription: [],
        nameRequired: [],
        withName: 0,
        missingName: [],
      },
      largeFileRatio: 0.5,
      totalFiles: 2,
    };

    const weights = defectWeights(defects);

    expect(weights["a.md"]).toBeCloseTo(
      (2 / 3) * DEFECT_WEIGHTS.brokenLink + DEFECT_WEIGHTS.oversized,
      6,
    );
    expect(weights["b.md"]).toBeCloseTo((1 / 3) * DEFECT_WEIGHTS.brokenLink, 6);
    expect(weights["d/MEMORY.md"]).toBeCloseTo(DEFECT_WEIGHTS.missingIndex, 6);
  });
});

describe("indexCoverage", () => {
  test("counts files per directory and flags directories that need an index", async () => {
    const repo = newRepo("dream-manifest-coverage-");
    writePolicy(repo, "legacy-only");
    for (const name of ["a", "b", "c", "d", "e", "f"]) {
      write(repo.dir, `big/${name}.md`, `# ${name}\n`);
    }
    write(repo.dir, "small/MEMORY.md", "# Small\n");
    write(repo.dir, "small/one.md", "# One\n");
    write(repo.dir, "root.md", "# Root\n");
    commitAll(repo, "initial memory");

    const layout = resolveDreamLayout(repo.dir);
    const files = await listMemoryFiles(repo.dir);
    const coverage = indexCoverage(files, layout);

    expect(coverage.directories).toEqual([
      {
        directory: "",
        files: 1,
        index: "INDEX.md",
        hasIndex: false,
        needsIndex: false,
      },
      {
        directory: "big",
        files: 6,
        index: "big/MEMORY.md",
        hasIndex: false,
        needsIndex: true,
      },
      {
        directory: "small",
        files: 1,
        index: "small/MEMORY.md",
        hasIndex: true,
        needsIndex: false,
      },
    ]);
    expect(coverage.needsIndex).toBe(1);
    expect(coverage.withIndex).toBe(0);
    expect(coverage.coverage).toBe(0);
  });
});
