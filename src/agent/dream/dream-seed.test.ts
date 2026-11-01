/**
 * Dream run seed (F-06 / 46-6-Fix-A W5, design §5.10.4, §6.10).
 *
 * Every case pins one promise of the seed: the sections render in priority
 * order, the manifest reports numbers instead of a table, a first run says
 * "first tracked run", the decay ranking and the core cost table carry the
 * per-file detail, deferred items are capped with a truncation note, and a
 * block that cannot be prepared degrades to one line instead of failing the
 * run. `HARUYUKI_HOME` is redirected per case and every repository is a
 * throwaway temp repo.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  applyRunToIndex,
  collectTrackedBlobShas,
  readDecayIndex,
  writeDecayIndex,
} from "@/agent/dream/dream-decay";
import type { DreamLayout } from "@/agent/dream/dream-layout";
import { listMemoryFiles } from "@/agent/dream/dream-manifest";
import type { DreamNote } from "@/agent/dream/dream-notes";
import type { DreamReviewMark } from "@/agent/dream/dream-review-marks";
import {
  collectDreamSeed,
  DREAM_DEFERRED_LIMIT,
  DREAM_PLAN_PATH,
  parseDeferredItems,
  readDeferredPlan,
  renderSeed,
} from "@/agent/dream/dream-seed";
import {
  createTempGitRepo,
  type TempGitRepo,
} from "@/test-utils/temp-git-repo";

const AGENT_ID = "agent-dream-seed";
const RUN_ID = "run-2026-11-01";
const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const MS_PER_DAY = 86_400_000;

let homeDir: string;
let previousHaruyukiHome: string | undefined;
const repos: TempGitRepo[] = [];
const dirs: string[] = [];

beforeEach(async () => {
  previousHaruyukiHome = process.env.HARUYUKI_HOME;
  homeDir = await mkdtemp(join(tmpdir(), "haruyuki-dream-seed-"));
  process.env.HARUYUKI_HOME = homeDir;
});

afterEach(async () => {
  if (previousHaruyukiHome === undefined) delete process.env.HARUYUKI_HOME;
  else process.env.HARUYUKI_HOME = previousHaruyukiHome;
  for (const repo of repos.splice(0)) repo.cleanup();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
  await rm(homeDir, { recursive: true, force: true });
});

function newRepo(): TempGitRepo {
  const repo = createTempGitRepo("dream-seed-");
  repos.push(repo);
  return repo;
}

function newDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dream-seed-plain-"));
  dirs.push(dir);
  return dir;
}

function write(dir: string, relativePath: string, content: string): void {
  const full = join(dir, relativePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
}

function commitAll(repo: TempGitRepo, message: string): void {
  repo.git("add", ".");
  repo.git("commit", "-qm", message);
}

function writePolicy(repo: TempGitRepo, policy: string): void {
  write(repo.dir, join(".git", "letta-memory-layout-policy"), policy);
}

function markOf(path: string): DreamReviewMark {
  return {
    version: 1,
    runId: RUN_ID,
    path,
    coverage: "content",
    evidence: "checked",
    createdAt: NOW,
  };
}

const NOTE: DreamNote = {
  version: 1,
  id: "note-1a2b3c4d",
  createdAt: NOW,
  author: "user",
  text: "Please check the reference index first.",
  source: {},
};

/** A legacy v1 memory repository with core, reference, notes and a report. */
function memoryFixture(): TempGitRepo {
  const repo = newRepo();
  writePolicy(repo, "legacy-only");
  write(repo.dir, "system/human.md", "# Human\n\n- prefers short answers\n");
  write(repo.dir, "system/project.md", "# Project\n\n- ships a CLI\n");
  write(repo.dir, "reference/a.md", "# A\n\n- alpha\n");
  write(repo.dir, "notes/b.md", "# B\n");
  write(repo.dir, "maintenance/dream-report.md", "# Report\n");
  write(repo.dir, "maintenance/MEMORY.md", "# Maintenance\n");
  commitAll(repo, "initial memory");
  return repo;
}

describe("collectDreamSeed", () => {
  test("prepares every block for a first tracked run", async () => {
    const repo = memoryFixture();
    const seed = await collectDreamSeed({
      agentId: AGENT_ID,
      memoryDir: repo.dir,
      runId: RUN_ID,
      now: NOW,
    });

    expect(seed.degraded).toEqual([]);
    expect(seed.layout?.format).toBe("memfs-v1");
    expect(seed.layout?.memoryDir).toBe(repo.dir);
    expect(seed.manifest?.files).toBe(6);
    expect(seed.manifest?.markdownFiles).toBe(6);
    expect(seed.manifest?.chars).toBeGreaterThan(0);
    expect(seed.manifest?.brokenLinks).toBe(0);
    expect(seed.manifest?.maxFileCharacters).toBe(20_000);
    expect(seed.changes?.firstTracked).toBe(true);
    // The harness rewrites maintenance/dream-report.md, so it never ranks.
    expect(seed.decay?.totalFiles).toBe(5);
    expect(seed.decay?.deltaStaleDays).toBe(365);
    expect(seed.decay?.excludedPaths).toEqual(["maintenance/dream-report.md"]);
    expect(seed.coreCost?.rows.map((row) => row.path)).toEqual([
      "system/human.md",
      "system/project.md",
    ]);
    expect(seed.coreCost?.rows.every((row) => row.tokens > 0)).toBe(true);
    expect(
      (seed.coreCost?.rows ?? []).reduce((sum, row) => sum + row.share, 0),
    ).toBeCloseTo(1, 10);
    expect(seed.deferred).toMatchObject({
      path: DREAM_PLAN_PATH,
      present: false,
      items: [],
      truncated: false,
    });
    expect(seed.notes).toEqual([]);
  });

  test("renders the sections in priority order", async () => {
    const repo = memoryFixture();
    const seed = await collectDreamSeed({
      agentId: AGENT_ID,
      memoryDir: repo.dir,
      runId: RUN_ID,
      now: NOW,
    });
    const rendered = renderSeed(seed);
    const headings = [
      "## Memory layout (mechanical facts)",
      "## Memory manifest",
      "## Changes since the last run",
      "## Decay ranking",
      "## Core context cost",
      `## Deferred items (${DREAM_PLAN_PATH})`,
    ];
    const positions = headings.map((heading) => rendered.indexOf(heading));
    for (const position of positions) expect(position).toBeGreaterThan(-1);
    expect(positions).toEqual(
      [...positions].sort((left, right) => left - right),
    );
    // No notes queued: the block is absent rather than an empty heading.
    expect(rendered).not.toContain("## Pending notes");
    // The manifest is numbers only: no path rows in that section.
    expect(rendered).toContain("files: 6 tracked, 6 Markdown");
    const manifestStart = rendered.indexOf("## Memory manifest");
    const manifestEnd = rendered.indexOf("## Changes since the last run");
    const manifestSection = rendered.slice(manifestStart, manifestEnd);
    expect(manifestSection).not.toContain("system/human.md");
  });

  test("puts pending notes last", async () => {
    const repo = memoryFixture();
    const seed = await collectDreamSeed({
      agentId: AGENT_ID,
      memoryDir: repo.dir,
      runId: RUN_ID,
      now: NOW,
      notes: [NOTE],
    });
    const rendered = renderSeed(seed);
    const notes = rendered.indexOf("## Pending notes");
    expect(notes).toBeGreaterThan(-1);
    expect(notes).toBeGreaterThan(rendered.indexOf(`## Deferred items`));
    expect(rendered).toContain("note-1a2b3c4d");
  });

  test("reports changes since the last recorded head and scores the interval", async () => {
    const repo = memoryFixture();
    const first = repo.git("rev-parse", "HEAD");
    write(repo.dir, "reference/a.md", "# A\n\n- alpha\n- beta\n- gamma\n");
    write(repo.dir, "reference/new.md", "# New\n");
    commitAll(repo, "dream(tidy): extend reference");

    await writeDecayIndex(AGENT_ID, {
      version: 1,
      lastDecayUpdateAt: NOW - 2 * MS_PER_DAY,
      lastRunHead: first,
      layout: "memfs-v1",
      totals: { lines: 9, chars: 90 },
      files: {
        "reference/a.md": { latestDecay: 5, lines: 3, chars: 12 },
      },
    });

    const seed = await collectDreamSeed({
      agentId: AGENT_ID,
      memoryDir: repo.dir,
      runId: RUN_ID,
      now: NOW,
    });
    expect(seed.degraded).toEqual([]);
    expect(seed.changes?.firstTracked).toBe(false);
    expect(seed.changes?.commits[0]?.subject).toBe(
      "dream(tidy): extend reference",
    );
    expect(seed.changes?.paths).toContain("reference/a.md");
    expect(seed.changes?.paths).toContain("reference/new.md");
    expect(seed.decay?.deltaStaleDays).toBeCloseTo(2, 10);
    expect(seed.decay?.layoutChanged).toBe(false);
    expect(seed.decay?.byPath["reference/a.md"]?.churn).toBeGreaterThan(0);
    expect(seed.decay?.byPath["reference/a.md"]?.latestDecay).toBe(5);

    const rendered = renderSeed(seed);
    expect(rendered).toContain("dream(tidy): extend reference");
    expect(rendered).toContain("reference/new.md (added");
    expect(rendered).not.toContain("first tracked run");
  });

  test("the collected view feeds the run-end ledger update", async () => {
    const repo = memoryFixture();
    const first = repo.git("rev-parse", "HEAD");
    write(repo.dir, "reference/a.md", "# A\n\n- alpha\n- beta\n");
    commitAll(repo, "dream(tidy): extend reference");
    await writeDecayIndex(AGENT_ID, {
      version: 1,
      lastDecayUpdateAt: NOW - MS_PER_DAY,
      lastRunHead: first,
      layout: "memfs-v1",
      totals: { lines: 9, chars: 90 },
      files: {
        "reference/a.md": { latestDecay: 20, lines: 3, chars: 12 },
      },
    });

    const seed = await collectDreamSeed({
      agentId: AGENT_ID,
      memoryDir: repo.dir,
      runId: RUN_ID,
      now: NOW,
    });
    const layout = seed.layout as DreamLayout;
    const index = await readDecayIndex(AGENT_ID);
    const next = applyRunToIndex({
      index,
      runId: RUN_ID,
      layout,
      now: NOW,
      headSha: seed.changes?.headSha ?? null,
      view: seed.decay as NonNullable<typeof seed.decay>,
      manifest: await listMemoryFiles(repo.dir, { includeUnprojected: true }),
      blobShas: await collectTrackedBlobShas(repo.dir),
      changedFiles: (seed.changes?.commits ?? []).flatMap(
        (commit) => commit.files,
      ),
      marks: [markOf("notes/b.md")],
    });
    await writeDecayIndex(AGENT_ID, next);

    const stored = await readDecayIndex(AGENT_ID);
    expect(stored.lastRunHead).toBe(seed.changes?.headSha ?? null);
    expect(stored.layout).toBe("memfs-v1");
    expect(stored.totals.lines).toBeGreaterThan(0);
    expect(stored.files["system/human.md"]).toBeDefined();
    // A changed file decays below its carried value; a marked file is cleared.
    expect(stored.files["reference/a.md"]?.latestDecay ?? 100).toBeLessThan(20);
    expect(stored.files["notes/b.md"]?.latestDecay ?? 100).toBeLessThan(1);
  });
});

describe("deferred plan", () => {
  test("a missing plan is no deferred work", async () => {
    const repo = memoryFixture();
    expect(await readDeferredPlan(repo.dir)).toEqual({
      path: DREAM_PLAN_PATH,
      present: false,
      items: [],
      total: 0,
      truncated: false,
      limit: DREAM_DEFERRED_LIMIT,
    });
  });

  test("groups items by heading, skips done checkboxes and code fences", () => {
    const items = parseDeferredItems(
      [
        "# Dream plan",
        "",
        "## Continue",
        "- [ ] finish `reference/a.md` — next: from 4.3",
        "- [x] already done",
        "",
        "## Blocked",
        "- waiting for user decision on the archive move",
        "",
        "## Mechanical",
        "1. fix broken links in notes/b.md",
        "",
        "## Notes",
        "- something unrelated",
        "",
        "```text",
        "- not an item, this is a sample",
        "```",
      ].join("\n"),
    );
    expect(items.map((item) => item.kind)).toEqual([
      "continue",
      "blocked",
      "mechanical",
      "other",
    ]);
    expect(items[0]?.text).toContain("finish `reference/a.md`");
    expect(items[1]?.section).toBe("Blocked");
  });

  test("renders the plan in the seed", async () => {
    const repo = memoryFixture();
    write(
      repo.dir,
      DREAM_PLAN_PATH,
      [
        "# Dream plan",
        "",
        "## Continue",
        "- finish the reference index",
        "",
        "## Blocked",
        "- waiting for user decision",
      ].join("\n"),
    );
    commitAll(repo, "dream(tidy): write plan");
    const seed = await collectDreamSeed({
      agentId: AGENT_ID,
      memoryDir: repo.dir,
      runId: RUN_ID,
      now: NOW,
    });
    expect(seed.deferred?.present).toBe(true);
    expect(seed.deferred?.items).toHaveLength(2);
    const rendered = renderSeed(seed);
    expect(rendered).toContain("- [continue] finish the reference index");
    expect(rendered).toContain("- [blocked] waiting for user decision");
  });

  test("caps at 20 items and says how many were cut", async () => {
    const repo = memoryFixture();
    const items = Array.from(
      { length: 25 },
      (_, index) => `- continue item ${index + 1}`,
    );
    write(
      repo.dir,
      DREAM_PLAN_PATH,
      ["# Dream plan", "", "## Continue", ...items].join("\n"),
    );
    commitAll(repo, "dream(tidy): write plan");
    const plan = await readDeferredPlan(repo.dir);
    expect(plan.items).toHaveLength(DREAM_DEFERRED_LIMIT);
    expect(plan.total).toBe(25);
    expect(plan.truncated).toBe(true);

    const seed = await collectDreamSeed({
      agentId: AGENT_ID,
      memoryDir: repo.dir,
      runId: RUN_ID,
      now: NOW,
    });
    const rendered = renderSeed(seed);
    expect(rendered).toContain(
      `(${25 - DREAM_DEFERRED_LIMIT} more items are not shown; the plan holds 25.)`,
    );
  });
});

describe("degradation", () => {
  test("a non-git directory degrades the manifest, decay and change blocks", async () => {
    const dir = newDir();
    write(dir, "notes.md", "# Notes\n");
    // A recorded head forces the change block to read git, which fails here.
    await writeDecayIndex(AGENT_ID, {
      version: 1,
      lastDecayUpdateAt: NOW,
      lastRunHead: "deadbeef",
      layout: "memfs-v1",
      totals: { lines: 0, chars: 0 },
      files: {},
    });
    const seed = await collectDreamSeed({
      agentId: AGENT_ID,
      memoryDir: dir,
      runId: RUN_ID,
      now: NOW,
    });
    expect(seed.layout).not.toBeNull();
    expect(seed.manifest).toBeNull();
    expect(seed.changes).toBeNull();
    expect(seed.decay).toBeNull();
    expect(seed.degraded.map((entry) => entry.block).sort()).toEqual([
      "changes",
      "decay",
      "manifest",
    ]);
    const rendered = renderSeed(seed);
    expect(rendered.match(/Unavailable in this run:/gu)).toHaveLength(3);
    // The blocks that do not need git still render.
    expect(rendered).toContain("## Memory layout (mechanical facts)");
    expect(rendered).toContain("No core files.");
    expect(rendered).toContain("none — the file does not exist.");
  });
});
