import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  collectRecallFiles,
  searchMemoryFiles,
  splitMemoryParagraphs,
} from "@/backend/local/memory-search";

/**
 * The projection facts these fixtures are built around, all from
 * `src/backend/local/system-prompt-compilation.ts`:
 *
 * - `memfs-v1` is detected by the absence of a root `MEMORY.md`. Core memory is
 *   `system/**`, and every other file is rendered into `<external_projection>` as
 *   a *path* with no body.
 * - `memfs-v2` is detected by a root `MEMORY.md`. Core memory is the set of
 *   root-level `.md` files; a child `MEMORY.md` is replaced by
 *   `<directory path="…/" index="…/MEMORY.md" />` — path, never body.
 * - `skills/` is never rendered, in either format.
 */

async function withMemoryDir(
  files: Readonly<Record<string, string | Uint8Array>>,
  run: (memoryDir: string) => void | Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "haru-memory-search-"));
  const memoryDir = join(root, "memory");
  try {
    await mkdir(memoryDir, { recursive: true });
    for (const [relativePath, content] of Object.entries(files)) {
      const absolutePath = join(memoryDir, ...relativePath.split("/"));
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content);
    }
    await run(memoryDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function pathsFor(
  files: Readonly<Record<string, string | Uint8Array>>,
): Promise<string[]> {
  let paths: string[] = [];
  await withMemoryDir(files, (memoryDir) => {
    paths = collectRecallFiles(memoryDir).map((file) => file.path);
  });
  return paths;
}

describe("splitMemoryParagraphs", () => {
  test("splits on blank lines and reports 1-based inclusive line numbers", () => {
    expect(splitMemoryParagraphs(["a", "b", "", "c", "", "", "d"])).toEqual([
      { startLine: 1, endLine: 2 },
      { startLine: 4, endLine: 4 },
      { startLine: 7, endLine: 7 },
    ]);
  });

  test("cuts a paragraph that exceeds the line cap", () => {
    expect(splitMemoryParagraphs(["1", "2", "3", "4", "5"], 2)).toEqual([
      { startLine: 1, endLine: 2 },
      { startLine: 3, endLine: 4 },
      { startLine: 5, endLine: 5 },
    ]);
  });

  test("treats whitespace-only lines as blank and ignores empty input", () => {
    expect(splitMemoryParagraphs(["", "  ", "\t", ""])).toEqual([]);
    expect(splitMemoryParagraphs(["a", "   ", "b"])).toEqual([
      { startLine: 1, endLine: 1 },
      { startLine: 3, endLine: 3 },
    ]);
  });
});

describe("collectRecallFiles", () => {
  test("memfs-v1 excludes system/ and skills/, keeps the external projection", async () => {
    // No root MEMORY.md -> memfs-v1, where `system/**` is core memory.
    const paths = await pathsFor({
      "system/persona.md": "persona",
      "system/human.md": "human",
      "system/notes/deep.md": "deep",
      "skills/mcp-over-bash/SKILL.md": "skill",
      "reference/notes.md": "notes",
      "reference/deeper/notes.md": "deeper",
      "ARCHIVE.md": "archive",
      "mods/dida365.ts": "export const x = 1;",
      ".git/objects/pack/fake.md": "not memory",
    });
    expect(paths).toEqual([
      "ARCHIVE.md",
      "reference/deeper/notes.md",
      "reference/notes.md",
    ]);
  });

  test("memfs-v2 excludes only root core files, and marks placement", async () => {
    const placements: Array<[string, string]> = [];
    await withMemoryDir(
      {
        "MEMORY.md": "root index",
        "persona.md": "persona",
        "onboarding.md": "onboarding",
        "skills/mcp-over-bash/SKILL.md": "skill",
        // A v1-era `system/` tree left behind after migration. Under v2 it is
        // NOT core — nothing renders it — so recall must still search it.
        "system/human.md": "legacy human",
        "reference/MEMORY.md": "reference index",
        "reference/notes.md": "notes",
        "reference/deep/notes.md": "deep notes",
        "raw/notes.md": "raw notes",
        ".git/objects/pack/fake.md": "not memory",
      },
      (memoryDir) => {
        for (const file of collectRecallFiles(memoryDir)) {
          placements.push([file.path, file.placement]);
        }
      },
    );
    expect(placements).toEqual([
      ["raw/notes.md", "unlisted"],
      ["reference/MEMORY.md", "deferred"],
      ["reference/deep/notes.md", "unlisted"],
      ["reference/notes.md", "deferred"],
      ["system/human.md", "unlisted"],
    ]);
  });
});

describe("searchMemoryFiles", () => {
  test("recalls the body of a deferred child index that the prompt only points at", async () => {
    // `reference/MEMORY.md` is exactly the blind spot: the compiled prompt
    // carries `<directory path="reference/" index="reference/MEMORY.md" />`, so
    // the model is told the file exists and never shown a word of it.
    await withMemoryDir(
      {
        "MEMORY.md": "root index",
        "reference/MEMORY.md":
          "# Reference\n\nThe ledger lives in ./ledger and reconciles nightly.",
      },
      (memoryDir) => {
        const result = searchMemoryFiles(memoryDir, "ledger reconciles");
        expect(result.entries.map((entry) => entry.path)).toEqual([
          "reference/MEMORY.md",
        ]);
        expect(result.entries[0]?.text).toContain("reconciles nightly");
        expect(result.entries[0]?.placement).toBe("deferred");
      },
    );
  });

  test("centers the excerpt on the hit line with two lines of context", async () => {
    const body = [
      "# Index",
      "",
      "Intro about unrelated topic.",
      "",
      "The finance system keeps the ledger in ./ledger.",
      "",
      "Tail note.",
    ].join("\n");
    await withMemoryDir(
      { "MEMORY.md": "root", "reference/MEMORY.md": body },
      (memoryDir) => {
        const [entry] = searchMemoryFiles(memoryDir, "finance ledger").entries;
        expect(entry?.path).toBe("reference/MEMORY.md");
        expect(entry?.startLine).toBe(3);
        expect(entry?.endLine).toBe(7);
        expect(entry?.text).toBe(
          [
            "Intro about unrelated topic.",
            "",
            "The finance system keeps the ledger in ./ledger.",
            "",
            "Tail note.",
          ].join("\n"),
        );
      },
    );
  });

  test("picks the best line inside a multi-line paragraph", async () => {
    const body = [
      "# Notes",
      "",
      "unrelated intro",
      "unrelated intro",
      "the finance system ledger is reconciled here",
      "unrelated tail",
      "unrelated tail",
    ].join("\n");
    await withMemoryDir(
      { "MEMORY.md": "root", "reference/notes.md": body },
      (memoryDir) => {
        const [entry] = searchMemoryFiles(
          memoryDir,
          "ledger reconciled",
        ).entries;
        expect(entry?.startLine).toBe(3);
        expect(entry?.endLine).toBe(7);
        expect(entry?.text.split("\n")).toContain(
          "the finance system ledger is reconciled here",
        );
      },
    );
  });

  test("clamps the excerpt to the file bounds", async () => {
    await withMemoryDir(
      {
        "MEMORY.md": "root",
        "reference/notes.md": "ledger first line\nsecond\n",
      },
      (memoryDir) => {
        const [entry] = searchMemoryFiles(memoryDir, "ledger").entries;
        expect(entry?.startLine).toBe(1);
        // The trailing newline is not a line: the file has two.
        expect(entry?.endLine).toBe(2);
      },
    );
  });

  test("honours excerptLines", async () => {
    const body = "one\ntwo\nledger three\nfour\nfive";
    await withMemoryDir(
      { "MEMORY.md": "root", "reference/notes.md": body },
      (memoryDir) => {
        const [entry] = searchMemoryFiles(memoryDir, "ledger", {
          excerptLines: 0,
        }).entries;
        expect(entry?.startLine).toBe(3);
        expect(entry?.endLine).toBe(3);
        expect(entry?.text).toBe("ledger three");
      },
    );
  });

  test("never returns an inlined core file, even when it matches", async () => {
    await withMemoryDir(
      {
        "MEMORY.md": "root index mentioning the ledger",
        "persona.md": "the ledger is mine",
        "reference/notes.md": "unrelated",
      },
      (memoryDir) => {
        const result = searchMemoryFiles(memoryDir, "ledger");
        expect(result.entries).toEqual([]);
        // The file was searched; it simply scored nothing worth returning.
        expect(result.stats.files).toBe(1);
      },
    );
  });

  test("never searches skills/ or non-Markdown files", async () => {
    const files = {
      "skills/scheduling/SKILL.md": "the zanzibar keyword",
      "mods/tool.ts": "const zanzibar = 1;",
      "profile.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
      "reference/notes.md": "unrelated",
    };
    await withMemoryDir(files, (memoryDir) => {
      const result = searchMemoryFiles(memoryDir, "zanzibar");
      expect(result.entries).toEqual([]);
      expect(result.stats.files).toBe(1);
      expect(result.stats.skippedFiles).toBe(0);
    });
  });

  test("never walks into .git", async () => {
    await withMemoryDir(
      {
        "MEMORY.md": "root",
        ".git/objects/pack/loose.md": "the zanzibar keyword",
        "reference/notes.md": "unrelated",
      },
      (memoryDir) => {
        expect(searchMemoryFiles(memoryDir, "zanzibar").entries).toEqual([]);
      },
    );
  });

  test("skips an undecodable file and still searches the rest", async () => {
    // A UTF-16LE BOM is not UTF-8; the strict decoder rejects it rather than
    // producing replacement characters that would then be searched as text.
    const utf16 = new Uint8Array([0xff, 0xfe, 0x6c, 0x00, 0x65, 0x00]);
    await withMemoryDir(
      {
        "MEMORY.md": "root",
        "reference/broken.md": utf16,
        "reference/notes.md": "the ledger is fine",
      },
      (memoryDir) => {
        const result = searchMemoryFiles(memoryDir, "ledger");
        expect(result.entries.map((entry) => entry.path)).toEqual([
          "reference/notes.md",
        ]);
        expect(result.stats.files).toBe(1);
        expect(result.stats.skippedFiles).toBe(1);
      },
    );
  });

  test("returns nothing, without throwing, when the workspace is missing", () => {
    const result = searchMemoryFiles(
      join(tmpdir(), "haru-memory-search-does-not-exist"),
      "ledger",
    );
    expect(result).toEqual({
      entries: [],
      stats: { files: 0, bytes: 0, records: 0, skippedFiles: 0 },
    });
  });

  test("does not scan for a query with no searchable terms", async () => {
    await withMemoryDir(
      { "MEMORY.md": "root", "reference/notes.md": "ledger" },
      (memoryDir) => {
        for (const query of ["", "   ", "!!!", "\u3002\u3001"]) {
          const result = searchMemoryFiles(memoryDir, query);
          expect(result.entries).toEqual([]);
          expect(result.stats.files).toBe(0);
        }
      },
    );
  });

  test("ranks by descending score, then by path and line", async () => {
    await withMemoryDir(
      {
        "MEMORY.md": "root",
        "reference/a.md": "the ledger\n\nunrelated",
        "reference/b.md": "the ledger\n\nunrelated",
        "reference/c.md": "unrelated\n\nunrelated",
      },
      (memoryDir) => {
        const result = searchMemoryFiles(memoryDir, "ledger");
        expect(result.entries.map((entry) => entry.path)).toEqual([
          "reference/a.md",
          "reference/b.md",
        ]);
        const scores = result.entries.map((entry) => entry.score);
        expect(scores[0]).toBeGreaterThan(0);
        expect(scores[0]).toBe(scores[1]);
      },
    );
  });

  test("applies limit and minScore to the ranked list", async () => {
    await withMemoryDir(
      {
        "MEMORY.md": "root",
        "reference/a.md": "the ledger",
        "reference/b.md": "the ledger",
      },
      (memoryDir) => {
        expect(
          searchMemoryFiles(memoryDir, "ledger", { limit: 1 }).entries,
        ).toHaveLength(1);
        expect(
          searchMemoryFiles(memoryDir, "ledger", { minScore: Number.MAX_VALUE })
            .entries,
        ).toEqual([]);
      },
    );
  });

  test("reports the scanned corpus in stats", async () => {
    await withMemoryDir(
      {
        "MEMORY.md": "root",
        "reference/a.md": "alpha\n\nbeta",
        "reference/b.md": "gamma",
      },
      (memoryDir) => {
        const { stats } = searchMemoryFiles(memoryDir, "alpha");
        expect(stats.files).toBe(2);
        expect(stats.records).toBe(3);
        expect(stats.bytes).toBeGreaterThan(0);
        expect(stats.skippedFiles).toBe(0);
      },
    );
  });
});
