/**
 * Dream decay ledger (F-06 / 46-6-Fix-A W3, design §5.10.2–§5.10.3, §6.5).
 *
 * Every case pins one promise of the recurrence: the first ranking starts from
 * "most stale" (Δstale = 365) instead of zero, Δstale has a one-year ceiling,
 * churn is clamped, the run-end update is a *full* update (untouched files keep
 * accumulating), a review mark clears the carried decay and the resume point, a
 * layout change re-sorts without resetting, and a corrupt ledger is reset rather
 * than crashing the run. `HARUYUKI_HOME` is redirected per case; the git cases
 * use throwaway repositories.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  applyRunToIndex,
  collectIntervalChanges,
  collectTrackedBlobShas,
  computeDecayView,
  createEmptyDecayIndex,
  DECAY_LIMITS,
  DIR_COEFFICIENTS,
  type DreamDecayIndex,
  dreamDirectoryCoefficient,
  getDreamDecayPath,
  readDecayIndex,
  renderDecayTable,
  resolveDeltaStaleDays,
  writeDecayIndex,
} from "@/agent/dream/dream-decay";
import type { DreamLayout } from "@/agent/dream/dream-layout";
import {
  DEFECT_WEIGHTS,
  type MemoryDefectScan,
  type MemoryFileChange,
  type MemoryFileFact,
} from "@/agent/dream/dream-manifest";
import type { DreamReviewMark } from "@/agent/dream/dream-review-marks";
import {
  createTempGitRepo,
  type TempGitRepo,
} from "@/test-utils/temp-git-repo";

const AGENT_ID = "agent-dream-decay";
const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const MS_PER_DAY = 86_400_000;

let homeDir: string;
let previousHaruyukiHome: string | undefined;
const repos: TempGitRepo[] = [];

beforeEach(async () => {
  previousHaruyukiHome = process.env.HARUYUKI_HOME;
  homeDir = await mkdtemp(join(tmpdir(), "haruyuki-dream-decay-"));
  process.env.HARUYUKI_HOME = homeDir;
});

afterEach(async () => {
  if (previousHaruyukiHome === undefined) delete process.env.HARUYUKI_HOME;
  else process.env.HARUYUKI_HOME = previousHaruyukiHome;
  for (const repo of repos.splice(0)) repo.cleanup();
  await rm(homeDir, { recursive: true, force: true });
});

function layoutOf(
  format: "memfs-v1" | "memfs-v2",
  corePaths: string[] = [],
): DreamLayout {
  const v2 = format === "memfs-v2";
  return {
    memoryDir: "/memory",
    policy: v2 ? "root-marker" : "legacy-only",
    format,
    corePaths,
    index: {
      required: v2,
      rootIndexPath: v2 ? "MEMORY.md" : "INDEX.md",
      rootIndexPresent: false,
      maxRootIndexLines: v2 ? null : 40,
      directoryIndexMinFiles: 5,
      frontmatterAllowed: !v2,
    },
    limits: {
      source: "defaults",
      maxFileCharacters: 20_000,
      maxCoreMemoryCharacters: 65_536,
      maxDepth: 2,
    },
    mismatch: null,
    reportOnly: false,
    warnings: [],
  };
}

function fact(path: string, lines: number, chars = lines * 10): MemoryFileFact {
  return {
    path,
    chars,
    lines,
    isMarkdown: path.endsWith(".md"),
    size: chars,
    projected: true,
  };
}

function emptyScan(): MemoryDefectScan {
  return {
    brokenLinks: [],
    missingIndexes: [],
    oversizedFiles: [],
    largeFiles: [],
    frontmatter: {
      total: 0,
      withDescription: 0,
      missingDescription: [],
      nameRequired: [],
      withName: 0,
      missingName: [],
    },
    largeFileRatio: 0,
    totalFiles: 0,
  };
}

function indexWith(
  entries: Record<
    string,
    { lines: number; chars?: number; latestDecay?: number; next?: string }
  >,
  overrides: Partial<DreamDecayIndex> = {},
): DreamDecayIndex {
  const index = createEmptyDecayIndex();
  for (const [path, entry] of Object.entries(entries)) {
    index.files[path] = {
      latestDecay: entry.latestDecay ?? 0,
      lines: entry.lines,
      chars: entry.chars ?? entry.lines * 10,
      ...(entry.next === undefined ? {} : { next: entry.next }),
    };
  }
  return { ...index, ...overrides };
}

function markOf(path: string, runId = "run-1"): DreamReviewMark {
  return {
    version: 1,
    runId,
    path,
    coverage: "content",
    evidence: "checked",
    createdAt: NOW,
  };
}

function changeOf(
  path: string,
  added: number,
  deleted: number,
  status: MemoryFileChange["status"] = "modified",
): MemoryFileChange {
  return { path, status, added, deleted };
}

describe("resolveDeltaStaleDays", () => {
  test("a fresh ledger starts at the one-year ceiling", () => {
    expect(resolveDeltaStaleDays(null, NOW)).toBe(DECAY_LIMITS.maxStaleDays);
  });

  test("counts days since the last update and caps at a year", () => {
    expect(resolveDeltaStaleDays(NOW - 2 * MS_PER_DAY, NOW)).toBeCloseTo(2, 10);
    expect(resolveDeltaStaleDays(NOW - 1_000 * MS_PER_DAY, NOW)).toBe(
      DECAY_LIMITS.maxStaleDays,
    );
  });

  test("a timestamp in the future (clock skew) yields zero, not a negative", () => {
    expect(resolveDeltaStaleDays(NOW + MS_PER_DAY, NOW)).toBe(0);
  });
});

describe("computeDecayView", () => {
  test("the first run ranks by importance with Δstale=365 and churn=1", () => {
    const layout = layoutOf("memfs-v1", ["system/human.md"]);
    const manifest = [
      fact("system/human.md", 100),
      fact("reference/a.md", 100),
      fact("notes/b.md", 100),
    ];
    const view = computeDecayView({
      index: createEmptyDecayIndex(),
      layout,
      manifest,
      defects: emptyScan(),
      now: NOW,
      intervalChangedLines: new Map(),
    });
    expect(view.deltaStaleDays).toBe(365);
    expect(view.layoutChanged).toBe(false);
    expect(view.totalLines).toBe(300);
    expect(view.totalFiles).toBe(3);
    expect(view.limit).toBe(DECAY_LIMITS.topN);
    expect(view.entries.map((entry) => entry.path)).toEqual([
      "system/human.md",
      "reference/a.md",
      "notes/b.md",
    ]);
    expect(view.byPath["system/human.md"]?.churn).toBe(1);
    expect(view.byPath["system/human.md"]?.importance).toBeCloseTo(
      DIR_COEFFICIENTS.core * (100 / 300),
      10,
    );
    expect(view.byPath["system/human.md"]?.decay).toBeCloseTo(
      2 * DIR_COEFFICIENTS.core * (100 / 300) * 365,
      8,
    );
  });

  test("churn uses the stored line count with a 20-line floor", () => {
    const layout = layoutOf("memfs-v1");
    const index = indexWith({
      "a.md": { lines: 100 },
      "b.md": { lines: 5 },
    });
    const view = computeDecayView({
      index,
      layout,
      manifest: [fact("a.md", 100), fact("b.md", 5), fact("c.md", 10)],
      defects: emptyScan(),
      now: NOW,
      intervalChangedLines: new Map([
        ["a.md", 50],
        ["b.md", 5],
      ]),
    });
    expect(view.byPath["a.md"]?.churn).toBeCloseTo(0.5, 10);
    expect(view.byPath["b.md"]?.churn).toBeCloseTo(5 / 20, 10);
    // A file the ledger has never seen is new: its whole content is churn.
    expect(view.byPath["c.md"]?.churn).toBe(1);
  });

  test("churn is clamped to 1", () => {
    const layout = layoutOf("memfs-v1");
    const view = computeDecayView({
      index: indexWith({ "a.md": { lines: 100 } }),
      layout,
      manifest: [fact("a.md", 100)],
      defects: emptyScan(),
      now: NOW,
      intervalChangedLines: new Map([["a.md", 10_000]]),
    });
    expect(view.byPath["a.md"]?.churn).toBe(1);
  });

  test("applies the directory coefficients from design §6.5", () => {
    const layout = layoutOf("memfs-v1", ["system/human.md"]);
    const manifest = [
      fact("system/human.md", 100),
      fact("reference/a.md", 100),
      fact("notes/b.md", 100),
      fact("draft/c.md", 100),
      fact("archive/d.md", 100),
      fact("skills/e/SKILL.md", 100),
      fact("MEMORY.md", 100),
      fact("INDEX.md", 100),
      fact("maintenance/dream-report.md", 100),
    ];
    const view = computeDecayView({
      index: createEmptyDecayIndex(),
      layout,
      manifest,
      defects: emptyScan(),
      now: NOW,
      intervalChangedLines: new Map(),
    });
    const modifier = (path: string): number | undefined =>
      view.byPath[path]?.dirModifier;
    expect(modifier("system/human.md")).toBe(DIR_COEFFICIENTS.core);
    expect(modifier("reference/a.md")).toBe(DIR_COEFFICIENTS.reference);
    expect(modifier("notes/b.md")).toBe(DIR_COEFFICIENTS.other);
    expect(modifier("draft/c.md")).toBe(DIR_COEFFICIENTS.draft);
    expect(modifier("archive/d.md")).toBe(DIR_COEFFICIENTS.archive);
    expect(modifier("skills/e/SKILL.md")).toBe(DIR_COEFFICIENTS.skills);
    expect(modifier("MEMORY.md")).toBe(DIR_COEFFICIENTS.index);
    expect(modifier("INDEX.md")).toBe(DIR_COEFFICIENTS.index);
    // The harness rewrites the report every run, so it never ranks.
    expect(modifier("maintenance/dream-report.md")).toBeUndefined();
    expect(view.excludedPaths).toEqual(["maintenance/dream-report.md"]);
    expect(view.totalLines).toBe(800);
    expect(dreamDirectoryCoefficient("ARCHIVE.md", layout)).toBe(
      DIR_COEFFICIENTS.archive,
    );
  });

  test("a layout change keeps carried decay and re-sorts under the new core set", () => {
    const manifest = [fact("system/a.md", 100), fact("notes/b.md", 100)];
    const carried = indexWith(
      {
        "system/a.md": { lines: 100, latestDecay: 10 },
        "notes/b.md": { lines: 100, latestDecay: 10 },
      },
      { layout: "memfs-v2" },
    );
    const v1 = computeDecayView({
      index: carried,
      layout: layoutOf("memfs-v1", ["system/a.md"]),
      manifest,
      defects: emptyScan(),
      now: NOW,
      intervalChangedLines: new Map(),
    });
    expect(v1.layoutChanged).toBe(true);
    expect(v1.entries[0]?.path).toBe("system/a.md");
    expect(v1.entries[0]?.latestDecay).toBe(10);

    const v2 = computeDecayView({
      index: { ...carried, layout: "memfs-v1" },
      layout: layoutOf("memfs-v2"),
      manifest,
      defects: emptyScan(),
      now: NOW,
      intervalChangedLines: new Map(),
    });
    expect(v2.layoutChanged).toBe(true);
    // No core files under v2, so both carry 0.5 and the path tie-break decides.
    expect(v2.entries.map((entry) => entry.path)).toEqual([
      "notes/b.md",
      "system/a.md",
    ]);
    expect(v2.entries.every((entry) => entry.latestDecay === 10)).toBe(true);
  });

  test("returns a full ranking plus a top-N slice", () => {
    const manifest = Array.from({ length: 25 }, (_, index) =>
      fact(`f${String(index).padStart(2, "0")}.md`, 100 - index),
    );
    const view = computeDecayView({
      index: createEmptyDecayIndex(),
      layout: layoutOf("memfs-v1"),
      manifest,
      defects: emptyScan(),
      now: NOW,
      intervalChangedLines: new Map(),
    });
    expect(view.entries).toHaveLength(25);
    expect(view.top).toHaveLength(DECAY_LIMITS.topN);
    expect(view.top).toEqual(view.entries.slice(0, DECAY_LIMITS.topN));
    for (let index = 1; index < view.entries.length; index += 1) {
      const previous = view.entries[index - 1];
      const current = view.entries[index];
      expect((previous?.decay ?? 0) >= (current?.decay ?? 0)).toBe(true);
    }
  });

  test("the defect term multiplies the increment", () => {
    const layout = layoutOf("memfs-v1");
    const defects = emptyScan();
    defects.brokenLinks = [
      { path: "a.md", syntax: "wiki", target: "missing", line: 1 },
    ];
    const view = computeDecayView({
      index: createEmptyDecayIndex(),
      layout,
      manifest: [fact("a.md", 100)],
      defects,
      now: NOW,
      intervalChangedLines: new Map(),
    });
    expect(view.byPath["a.md"]?.defect).toBeGreaterThan(0);
    expect(view.byPath["a.md"]?.decay).toBeCloseTo(
      2 *
        DIR_COEFFICIENTS.other *
        1 *
        365 *
        (1 + (view.byPath["a.md"]?.defect ?? 0)),
      8,
    );
  });

  test("a missing directory index raises that directory's files", () => {
    // v2 requires MEMORY.md in every directory. The defect is directory-level,
    // so the files the directory actually holds carry the (1+defect) term —
    // previously the weight landed on the nonexistent index path and vanished.
    const layout = layoutOf("memfs-v2");
    const manifest = [
      fact("MEMORY.md", 20),
      fact("notes/a.md", 100),
      fact("notes/b.md", 100),
      fact("notes/deep/c.md", 100),
    ];
    const defects = emptyScan();
    defects.missingIndexes = [{ directory: "notes", index: "notes/MEMORY.md" }];
    const withoutIndex = computeDecayView({
      index: createEmptyDecayIndex(),
      layout,
      manifest,
      defects: emptyScan(),
      now: NOW,
      intervalChangedLines: new Map(),
    });
    const withDefect = computeDecayView({
      index: createEmptyDecayIndex(),
      layout,
      manifest,
      defects,
      now: NOW,
      intervalChangedLines: new Map(),
    });
    for (const path of ["notes/a.md", "notes/b.md"]) {
      expect(withDefect.byPath[path]?.defect).toBeCloseTo(
        DEFECT_WEIGHTS.missingIndex / 2,
        10,
      );
      expect(withDefect.byPath[path]?.decay ?? 0).toBeGreaterThan(
        withoutIndex.byPath[path]?.decay ?? 0,
      );
    }
    // The missing index path does not exist, so it must not appear in the view;
    // the root index and nested files are not in that directory's own scope.
    expect(withDefect.byPath["notes/MEMORY.md"]).toBeUndefined();
    expect(withDefect.byPath["MEMORY.md"]?.defect).toBe(0);
    expect(withDefect.byPath["notes/deep/c.md"]?.defect).toBe(0);
  });
});

describe("the ledger file", () => {
  test("lives under the harness home", () => {
    const path = getDreamDecayPath(AGENT_ID);
    expect(path).toBe(join(homeDir, "dream", "decay", `${AGENT_ID}.json`));
    expect(path).not.toContain(".haruyuki");
  });

  test("round-trips through a temp file and leaves no temp behind", async () => {
    const index: DreamDecayIndex = {
      ...indexWith({
        "system/a.md": {
          lines: 10,
          chars: 100,
          latestDecay: 1.5,
          next: "continue from 4.3",
        },
      }),
      lastDecayUpdateAt: NOW,
      lastRunHead: "abc123",
      layout: "memfs-v1",
      totals: { lines: 10, chars: 100 },
    };
    await writeDecayIndex(AGENT_ID, index);
    expect(await readDecayIndex(AGENT_ID)).toEqual(index);
    const raw = await readFile(getDreamDecayPath(AGENT_ID), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    await expect(
      readFile(`${getDreamDecayPath(AGENT_ID)}.tmp`, "utf8"),
    ).rejects.toThrow();
  });

  test("a missing file is a fresh ledger", async () => {
    expect(await readDecayIndex("agent-never-ran")).toEqual(
      createEmptyDecayIndex(),
    );
  });

  test("a corrupt file is reset instead of throwing", async () => {
    const path = getDreamDecayPath(AGENT_ID);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{not json", "utf8");
    expect(await readDecayIndex(AGENT_ID)).toEqual(createEmptyDecayIndex());

    await writeFile(path, JSON.stringify({ version: 99, files: {} }), "utf8");
    expect(await readDecayIndex(AGENT_ID)).toEqual(createEmptyDecayIndex());
  });

  test("drops a malformed entry but keeps the valid ones", async () => {
    const path = getDreamDecayPath(AGENT_ID);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        lastDecayUpdateAt: NOW,
        lastRunHead: "abc",
        layout: "memfs-v1",
        totals: { lines: 10, chars: 100 },
        files: {
          "good.md": { latestDecay: 2, lines: 10, chars: 100 },
          "bad.md": { latestDecay: "nope", lines: 10, chars: 100 },
        },
      }),
      "utf8",
    );
    const index = await readDecayIndex(AGENT_ID);
    expect(Object.keys(index.files)).toEqual(["good.md"]);
    expect(index.lastRunHead).toBe("abc");
    expect(index.totals).toEqual({ lines: 10, chars: 100 });
  });
});

describe("applyRunToIndex", () => {
  function baseView() {
    const layout = layoutOf("memfs-v1", ["system/a.md"]);
    const index = indexWith({
      "system/a.md": { lines: 100 },
      "notes/b.md": { lines: 100 },
    });
    const manifest = [fact("system/a.md", 100), fact("notes/b.md", 100)];
    const view = computeDecayView({
      index,
      layout,
      manifest,
      defects: emptyScan(),
      now: NOW,
      intervalChangedLines: new Map(),
    });
    return { layout, index, manifest, view };
  }

  test("a changed file decays by the sigmoid rule", () => {
    const { layout, index, manifest, view } = baseView();
    const next = applyRunToIndex({
      index,
      runId: "run-1",
      layout,
      now: NOW + 3_600_000,
      headSha: "head-1",
      view,
      manifest,
      blobShas: new Map([
        ["system/a.md", "sha-a"],
        ["notes/b.md", "sha-b"],
      ]),
      changedFiles: [changeOf("system/a.md", 5, 5)],
      marks: [],
    });
    const x = 10 / 100;
    const rr = 2 / (1 + Math.exp(6 * x));
    const increment = view.byPath["system/a.md"]?.increment ?? 0;
    expect(next.files["system/a.md"]?.latestDecay).toBeCloseTo(
      increment * rr,
      8,
    );
    expect(next.files["system/a.md"]?.sha).toBe("sha-a");
    expect(next.lastDecayUpdateAt).toBe(NOW + 3_600_000);
    expect(next.lastRunHead).toBe("head-1");
    expect(next.layout).toBe("memfs-v1");
    expect(next.totals).toEqual({ lines: 200, chars: 2000 });
  });

  test("untouched files accumulate at rr = 1", () => {
    const { layout, index, manifest, view } = baseView();
    const next = applyRunToIndex({
      index,
      runId: "run-1",
      layout,
      now: NOW,
      headSha: null,
      view,
      manifest,
      blobShas: new Map(),
      changedFiles: [],
      marks: [],
    });
    const increment = view.byPath["notes/b.md"]?.increment ?? 0;
    expect(next.files["notes/b.md"]?.latestDecay).toBeCloseTo(increment, 10);
    expect(next.lastRunHead).toBeNull();
  });

  test("a review mark clears the carried decay and the resume point", () => {
    const { layout, index, manifest, view } = baseView();
    index.files["notes/b.md"] = {
      ...(index.files["notes/b.md"] ?? {
        latestDecay: 0,
        lines: 100,
        chars: 1000,
      }),
      next: "continue from 4.3",
    };
    const next = applyRunToIndex({
      index,
      runId: "run-1",
      layout,
      now: NOW,
      headSha: null,
      view,
      manifest,
      blobShas: new Map(),
      changedFiles: [],
      marks: [markOf("notes/b.md")],
    });
    expect(next.files["notes/b.md"]?.latestDecay ?? 1).toBeLessThan(1);
    expect(next.files["notes/b.md"]?.next).toBeUndefined();
  });

  test("an unmarked file keeps its next resume point", () => {
    const { layout, index, manifest, view } = baseView();
    index.files["notes/b.md"] = {
      ...(index.files["notes/b.md"] ?? {
        latestDecay: 0,
        lines: 100,
        chars: 1000,
      }),
      next: "continue from 4.3",
    };
    const next = applyRunToIndex({
      index,
      runId: "run-1",
      layout,
      now: NOW,
      headSha: null,
      view,
      manifest,
      blobShas: new Map(),
      changedFiles: [],
      marks: [],
    });
    expect(next.files["notes/b.md"]?.next).toBe("continue from 4.3");
  });

  test("a file created by the run joins the table", () => {
    const { layout, index, manifest, view } = baseView();
    const withNew = [...manifest, fact("new/c.md", 100)];
    const next = applyRunToIndex({
      index,
      runId: "run-1",
      layout,
      now: NOW,
      headSha: null,
      view,
      manifest: withNew,
      blobShas: new Map([["new/c.md", "sha-c"]]),
      changedFiles: [changeOf("new/c.md", 100, 0, "added")],
      marks: [],
    });
    expect(next.files["new/c.md"]?.lines).toBe(100);
    expect(next.files["new/c.md"]?.sha).toBe("sha-c");
    // A whole new file is fully changed, so rr is effectively zero.
    expect(next.files["new/c.md"]?.latestDecay ?? 1).toBeLessThan(1e-6);
  });

  test("a deleted file leaves the table", () => {
    const { layout, index, manifest, view } = baseView();
    index.files["old/gone.md"] = { latestDecay: 5, lines: 10, chars: 100 };
    const next = applyRunToIndex({
      index,
      runId: "run-1",
      layout,
      now: NOW,
      headSha: null,
      view,
      manifest,
      blobShas: new Map(),
      changedFiles: [changeOf("old/gone.md", 0, 10, "deleted")],
      marks: [],
    });
    expect(next.files["old/gone.md"]).toBeUndefined();
  });

  test("a rename reads as delete + add (no guessing)", () => {
    const { layout, index, manifest, view } = baseView();
    index.files["notes/old.md"] = { latestDecay: 5, lines: 10, chars: 100 };
    const next = applyRunToIndex({
      index,
      runId: "run-1",
      layout,
      now: NOW,
      headSha: null,
      view,
      manifest: [...manifest, fact("notes/new.md", 10)],
      blobShas: new Map(),
      changedFiles: [
        changeOf("notes/old.md", 0, 10, "deleted"),
        changeOf("notes/new.md", 10, 0, "added"),
      ],
      marks: [],
    });
    expect(next.files["notes/old.md"]).toBeUndefined();
    expect(next.files["notes/new.md"]).toBeDefined();
  });
});

describe("renderDecayTable", () => {
  test("renders four columns, the next resume point and the ranking caveat", () => {
    const index = indexWith({
      "system/a.md": { lines: 100, next: "从 4.3 继续" },
    });
    const view = computeDecayView({
      index,
      layout: layoutOf("memfs-v1", ["system/a.md"]),
      manifest: [fact("system/a.md", 100), fact("notes/b.md", 20)],
      defects: emptyScan(),
      now: NOW,
      intervalChangedLines: new Map(),
    });
    const table = renderDecayTable(view);
    expect(table).toContain("| path | decay | size | note |");
    expect(table).toContain("not a todo list");
    expect(table).toContain("next: 从 4.3 继续");
    expect(table).toContain("| system/a.md |");
    expect(table).toContain("top 2 of 2 files");
  });

  test("caps at the limit and says how many rows are hidden", () => {
    const manifest = Array.from({ length: 25 }, (_, index) =>
      fact(`f${String(index).padStart(2, "0")}.md`, 100),
    );
    const view = computeDecayView({
      index: createEmptyDecayIndex(),
      layout: layoutOf("memfs-v1"),
      manifest,
      defects: emptyScan(),
      now: NOW,
      intervalChangedLines: new Map(),
    });
    const table = renderDecayTable(view);
    expect(table).toContain("top 20 of 25 files");
    expect(table).toContain("and 5 more files not shown");
    expect(
      table.split("\n").filter((line) => line.startsWith("| f")),
    ).toHaveLength(20);
  });

  test("mentions a layout change and escapes table separators", () => {
    const index = indexWith(
      { "system/a.md": { lines: 100, next: "a | b" } },
      { layout: "memfs-v2" },
    );
    const view = computeDecayView({
      index,
      layout: layoutOf("memfs-v1", ["system/a.md"]),
      manifest: [fact("system/a.md", 100)],
      defects: emptyScan(),
      now: NOW,
      intervalChangedLines: new Map(),
    });
    const table = renderDecayTable(view);
    expect(table).toContain("The layout changed");
    expect(table).toContain("a \\| b");
  });

  test("an empty repository renders a plain statement", () => {
    const view = computeDecayView({
      index: createEmptyDecayIndex(),
      layout: layoutOf("memfs-v1"),
      manifest: [],
      defects: emptyScan(),
      now: NOW,
      intervalChangedLines: new Map(),
    });
    expect(renderDecayTable(view)).toContain("No files to rank.");
  });
});

describe("git interval helpers", () => {
  function newRepo(): TempGitRepo {
    const repo = createTempGitRepo("dream-decay-git-");
    repos.push(repo);
    return repo;
  }

  function write(dir: string, relativePath: string, content: string): void {
    const full = join(dir, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  }

  test("collectIntervalChanges sums added and deleted lines per path", async () => {
    const repo = newRepo();
    write(repo.dir, "a.md", "one\ntwo\n");
    repo.git("add", ".");
    repo.git("commit", "-qm", "first");
    const first = repo.git("rev-parse", "HEAD");

    write(repo.dir, "a.md", "one\ntwo\nthree\nfour\n");
    write(repo.dir, "b.md", "new file\n");
    repo.git("add", ".");
    repo.git("commit", "-qm", "second");

    const changes = await collectIntervalChanges(repo.dir, first);
    expect(changes.get("a.md")).toBe(2);
    expect(changes.get("b.md")).toBe(1);
    expect((await collectIntervalChanges(repo.dir, null)).size).toBe(0);
  });

  test("a non-revision previous head never reaches git's argv", async () => {
    // The ledger is hand-editable. `--output=leak.txt..HEAD` would be an option
    // to `git diff`, so the guard must read it as "no interval" first.
    const repo = newRepo();
    write(repo.dir, "a.md", "# A\n");
    repo.git("add", ".");
    repo.git("commit", "-qm", "first");

    expect(
      (await collectIntervalChanges(repo.dir, "--output=leak.txt")).size,
    ).toBe(0);
    expect(existsSync(join(repo.dir, "leak.txt"))).toBe(false);
  });

  test("collectTrackedBlobShas matches the object hashes of the tree", async () => {
    const repo = newRepo();
    write(repo.dir, "a.md", "# A\n");
    write(repo.dir, "dir/b.md", "# B\n");
    repo.git("add", ".");
    repo.git("commit", "-qm", "first");

    const shas = await collectTrackedBlobShas(repo.dir);
    expect(shas.get("a.md")).toBe(repo.git("hash-object", "a.md"));
    expect(shas.get("dir/b.md")).toBe(repo.git("hash-object", "dir/b.md"));
  });
});
