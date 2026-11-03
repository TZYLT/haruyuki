import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { embeddingVectorUnitDir } from "@/backend/local/embedding-format";
import {
  buildMemoryVectorFilePlan,
  buildMemoryVectorPlan,
  isMemoryVectorFileStale,
  memoryFileKey,
  memoryVectorParentId,
  parseMemoryVectorParentId,
  readMemoryVectorFileSignature,
  readMemoryVectorParentText,
} from "@/backend/local/embedding-memory";
import { MEMORY_RECORD_MAX_LINES } from "@/backend/local/memory-search";
import { createTempGitRepo } from "@/test-utils/temp-git-repo";

/**
 * B4's memory-side vector corpus (48-1 §6.2 / 48-2 §4.2–§4.3).
 *
 * Everything is synthetic and lives under the OS temp directory: a memory
 * workspace is a git repository of Markdown files, so the fixture builds one
 * file at a time and never points at a real `~/.haruyuki` (docs/31 A2). The
 * module writes nothing, which is asserted rather than assumed.
 */

let homeDir: string;
let backendDir: string;
let previousHome: string | undefined;
let previousBackend: string | undefined;
let workspace: string;

beforeAll(() => {
  homeDir = mkdtempSync(join(tmpdir(), "haru-embedding-memory-home-"));
  backendDir = mkdtempSync(join(tmpdir(), "haru-embedding-memory-backend-"));
  previousHome = process.env.HARUYUKI_HOME;
  previousBackend = process.env.LETTA_LOCAL_BACKEND_DIR;
  process.env.HARUYUKI_HOME = homeDir;
  process.env.LETTA_LOCAL_BACKEND_DIR = backendDir;
});

afterAll(() => {
  if (previousHome === undefined) delete process.env.HARUYUKI_HOME;
  else process.env.HARUYUKI_HOME = previousHome;
  if (previousBackend === undefined) delete process.env.LETTA_LOCAL_BACKEND_DIR;
  else process.env.LETTA_LOCAL_BACKEND_DIR = previousBackend;
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(backendDir, { recursive: true, force: true });
});

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "haru-embedding-memory-ws-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function writeDoc(root: string, relativePath: string, content: string): string {
  const absolute = join(root, ...relativePath.split("/"));
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
  return absolute;
}

const PLAN_DOC = [
  "# 计划",
  "",
  "第一段内容，介绍背景与目标。",
  "",
  "## 细节",
  "",
  "第二段内容，说明实现方式。",
].join("\n");

describe("buildMemoryVectorPlan", () => {
  test("turns each paragraph into a parent with a chunk plan", () => {
    writeDoc(workspace, "notes/plan.md", PLAN_DOC);
    const plan = buildMemoryVectorPlan(workspace, { gitRevision: "rev-1" });

    expect(plan.stats).toMatchObject({
      files: 1,
      skippedFiles: 0,
      parents: 4,
      skippedParents: 0,
      bytes: Buffer.byteLength(PLAN_DOC, "utf8"),
    });
    expect(plan.gitRevision).toBe("rev-1");
    expect(plan.files).toHaveLength(1);

    const file = plan.files[0];
    expect(file).toBeDefined();
    if (file === undefined) return;
    expect(file.signature.path).toBe("notes/plan.md");
    expect(file.signature.fileKey).toBe(memoryFileKey("notes/plan.md"));

    const parents = file.parents;
    expect(parents.map((parent) => parent.parentId)).toEqual([
      memoryVectorParentId("notes/plan.md", 1, 1),
      memoryVectorParentId("notes/plan.md", 3, 3),
      memoryVectorParentId("notes/plan.md", 5, 5),
      memoryVectorParentId("notes/plan.md", 7, 7),
    ]);
    expect(parents.map((parent) => parent.titlePrefix)).toEqual([
      "notes/plan.md › 计划",
      "notes/plan.md › 计划",
      "notes/plan.md › 细节",
      "notes/plan.md › 细节",
    ]);
    expect(parents[1]?.text).toBe("第一段内容，介绍背景与目标。");

    for (const parent of parents) {
      expect(parent.plan.parentId).toBe(parent.parentId);
      expect(parent.records.length).toBeGreaterThan(0);
      for (const record of parent.records) {
        expect(record.parentId).toBe(parent.parentId);
        expect(record.parentLineSpan).toBeDefined();
        expect(record.parentLineSpan?.startLine).toBeGreaterThanOrEqual(1);
        expect(record.parentLineSpan?.endLine).toBeLessThanOrEqual(7);
      }
    }
    expect(plan.stats.chunks).toBeGreaterThanOrEqual(4);
  });

  test("splits a long paragraph at the memory record line cap", () => {
    const lines = Array.from(
      { length: MEMORY_RECORD_MAX_LINES * 2 + 5 },
      (_unused, index) => `第${index + 1}行内容。`,
    );
    writeDoc(workspace, "notes/long.md", lines.join("\n"));
    const plan = buildMemoryVectorPlan(workspace, { gitRevision: "rev-1" });
    const file = plan.files[0];
    expect(file).toBeDefined();
    if (file === undefined) return;
    expect(
      file.parents.map((parent) => [parent.startLine, parent.endLine]),
    ).toEqual([
      [1, MEMORY_RECORD_MAX_LINES],
      [MEMORY_RECORD_MAX_LINES + 1, MEMORY_RECORD_MAX_LINES * 2],
      [MEMORY_RECORD_MAX_LINES * 2 + 1, MEMORY_RECORD_MAX_LINES * 2 + 5],
    ]);
    expect(plan.stats.parents).toBe(3);
  });

  test("marks a pure-code paragraph lexical-only instead of dropping it", () => {
    writeDoc(
      workspace,
      "notes/code.md",
      ["```ts", "const a = 1;", "```"].join("\n"),
    );
    const plan = buildMemoryVectorPlan(workspace, { gitRevision: "rev-1" });
    const file = plan.files[0];
    expect(file).toBeDefined();
    if (file === undefined) return;
    expect(file.parents).toHaveLength(1);
    expect(file.parents[0]?.plan.skipVector).toBe(true);
    expect(file.parents[0]?.plan.skipReason).toBe("code-only");
    expect(file.parents[0]?.records).toEqual([]);
    expect(plan.stats.skippedParents).toBe(1);
    expect(plan.stats.chunks).toBe(0);
  });

  test("excludes core memory and skills, the way memory-search does", () => {
    writeDoc(workspace, "MEMORY.md", "# 索引\n\n根索引正文。");
    writeDoc(workspace, "skills/skill.md", "# 技能\n\n不应进入召回。");
    writeDoc(workspace, "notes/plan.md", PLAN_DOC);
    // A root MEMORY.md flips the format to memfs-v2, where MEMORY.md itself is
    // core memory already inlined in the prompt.
    const plan = buildMemoryVectorPlan(workspace, { gitRevision: "rev-1" });
    expect(plan.files.map((file) => file.signature.path)).toEqual([
      "notes/plan.md",
    ]);
  });

  test("counts an unreadable file and keeps building", () => {
    writeDoc(workspace, "notes/plan.md", PLAN_DOC);
    // A UTF-16LE BOM is not decodable as UTF-8; `decodeUtf8TextStrict` throws.
    writeFileSync(
      join(workspace, "notes", "binary.md"),
      Buffer.from([0xff, 0xfe, 0x41, 0x00]),
    );
    const plan = buildMemoryVectorPlan(workspace, { gitRevision: "rev-1" });
    expect(plan.stats.files).toBe(1);
    expect(plan.stats.skippedFiles).toBe(1);
  });

  test("writes nothing: no index or state under the harness home", () => {
    writeDoc(workspace, "notes/plan.md", PLAN_DOC);
    buildMemoryVectorPlan(workspace);
    expect(readdirSync(homeDir)).toEqual([]);
    expect(readdirSync(workspace).sort()).toEqual(["notes"]);
  });
});

describe("invalidation signatures", () => {
  test("is stable while the file is unchanged and stale after an edit", () => {
    writeDoc(workspace, "notes/plan.md", PLAN_DOC);
    const first = buildMemoryVectorPlan(workspace, { gitRevision: "rev-1" });
    const second = buildMemoryVectorPlan(workspace, { gitRevision: "rev-1" });
    expect(second.signature).toBe(first.signature);
    const firstFile = first.files[0];
    const secondFile = second.files[0];
    expect(firstFile).toBeDefined();
    expect(secondFile).toBeDefined();
    if (firstFile === undefined || secondFile === undefined) return;
    expect(
      isMemoryVectorFileStale(firstFile.signature, secondFile.signature),
    ).toBe(false);

    writeDoc(workspace, "notes/plan.md", `${PLAN_DOC}\n\n新增一段。`);
    const third = buildMemoryVectorPlan(workspace, { gitRevision: "rev-1" });
    const thirdFile = third.files[0];
    expect(thirdFile).toBeDefined();
    if (thirdFile === undefined) return;
    expect(third.signature).not.toBe(first.signature);
    expect(
      isMemoryVectorFileStale(firstFile.signature, thirdFile.signature),
    ).toBe(true);
  });

  test("a revision-only change is stale even when mtime and size are equal", () => {
    writeDoc(workspace, "notes/plan.md", PLAN_DOC);
    const file = buildMemoryVectorFilePlan(workspace, "notes/plan.md", {
      gitRevision: "rev-1",
    });
    expect(file).toBeDefined();
    if (file === undefined) return;
    const stored = file.signature;
    const current = readMemoryVectorFileSignature(workspace, "notes/plan.md", {
      gitRevision: "rev-2",
    });
    expect(current).toBeDefined();
    if (current === undefined) return;
    expect(current.mtimeMs).toBe(stored.mtimeMs);
    expect(current.size).toBe(stored.size);
    expect(isMemoryVectorFileStale(stored, current)).toBe(true);
  });

  test("reads the committed revision from a real memory repository", () => {
    const repo = createTempGitRepo("haru-embedding-memory-git-");
    try {
      writeDoc(repo.dir, "notes/plan.md", PLAN_DOC);
      repo.git("add", "-A");
      repo.git("commit", "-m", "first");
      const first = buildMemoryVectorPlan(repo.dir);
      expect(first.gitRevision).toMatch(/^[0-9a-f]{40}$/);
      expect(first.files[0]?.signature.gitRevision).toBe(first.gitRevision);

      writeDoc(repo.dir, "notes/plan.md", `${PLAN_DOC}\n\n第二版补充。`);
      repo.git("add", "-A");
      repo.git("commit", "-m", "second");
      const second = buildMemoryVectorPlan(repo.dir);
      expect(second.gitRevision).not.toBe(first.gitRevision);
      expect(second.signature).not.toBe(first.signature);
    } finally {
      repo.cleanup();
    }
  });
});

describe("parent identity", () => {
  test("parent ids round-trip and reject malformed spans", () => {
    const parentId = memoryVectorParentId("notes/plan.md", 4, 6);
    expect(parentId).toBe("memory:notes/plan.md#L4-L6");
    expect(parseMemoryVectorParentId(parentId)).toEqual({
      path: "notes/plan.md",
      startLine: 4,
      endLine: 6,
    });
    // A `#` in the path is legal: the line span is the only fixed-shape tail.
    expect(parseMemoryVectorParentId("memory:a#b.md#L1-L2")).toEqual({
      path: "a#b.md",
      startLine: 1,
      endLine: 2,
    });

    expect(parseMemoryVectorParentId("memory:notes/plan.md")).toBeUndefined();
    expect(
      parseMemoryVectorParentId("memory:notes/plan.md#L1"),
    ).toBeUndefined();
    expect(
      parseMemoryVectorParentId("memory:notes/plan.md#L2-L1"),
    ).toBeUndefined();
    expect(parseMemoryVectorParentId("notes/plan.md#L1-L2")).toBeUndefined();
    expect(
      parseMemoryVectorParentId("memory:notes/plan.md#L0-L2"),
    ).toBeUndefined();
  });

  test("the file key is a safe B2 segment and unique per path", () => {
    const key = memoryFileKey("notes/plan.md");
    expect(key).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    expect(memoryFileKey("notes/plan.md")).toBe(key);
    expect(memoryFileKey("notes/other.md")).not.toBe(key);
    expect(memoryFileKey("资料/部署.md")).toMatch(
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    );
    // B2 validates the key as one path component; a derived key must pass it.
    expect(() =>
      embeddingVectorUnitDir(
        {
          agentId: "agent-1",
          spaceId: "space-0123456789abcdef",
          memoryFileKey: key,
        },
        { root: workspace },
      ),
    ).not.toThrow();
  });
});

describe("readMemoryVectorParentText", () => {
  test("re-reads a parent from the live file", () => {
    writeDoc(workspace, "notes/plan.md", PLAN_DOC);
    const plan = buildMemoryVectorPlan(workspace, { gitRevision: "rev-1" });
    const parent = plan.files[0]?.parents[1];
    expect(parent).toBeDefined();
    if (parent === undefined) return;
    const read = readMemoryVectorParentText(workspace, parent.parentId);
    expect(read).toBeDefined();
    if (read === undefined) return;
    expect(read.text).toBe(parent.text);
    expect(read.startLine).toBe(parent.startLine);
    expect(read.lines.join("\n")).toBe(PLAN_DOC);
  });

  test("rejects unknown, out-of-range, and escaping parent ids", () => {
    writeDoc(workspace, "notes/plan.md", PLAN_DOC);
    expect(
      readMemoryVectorParentText(workspace, "memory:notes/missing.md#L1-L1"),
    ).toBeUndefined();
    expect(
      readMemoryVectorParentText(workspace, "memory:notes/plan.md#L99-L100"),
    ).toBeUndefined();
    // `..` must not read outside the memory workspace.
    expect(
      readMemoryVectorParentText(workspace, "memory:../../outside.md#L1-L1"),
    ).toBeUndefined();
    expect(
      readMemoryVectorParentText(workspace, "notes/plan.md"),
    ).toBeUndefined();
  });
});
