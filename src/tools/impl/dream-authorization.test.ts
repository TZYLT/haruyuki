/**
 * `DreamAuthorization` (F-06 R-5.4.5, Q-18; design §八).
 *
 * The important half of this tool is what it says when it finds nothing: "no
 * authorization", never a guess. The second half is the carrier rule: exactly
 * one file per memory layout is read, and a missing carrier is reported with
 * the path the run expected instead of searching elsewhere.
 *
 * The parser is exercised directly so a change to the entry convention is
 * visible without a filesystem, and the tool is exercised against throwaway
 * memory directories in both layouts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DREAM_AUTHORIZATION_LEGACY_PATH,
  DREAM_AUTHORIZATION_PATH,
  dream_authorization,
  isAuthorizationActive,
  parseDreamAuthorizationEntries,
  resolveAuthorizationCarrierPath,
  utcDateString,
} from "@/tools/impl/dream-authorization";
import { TOOL_DEFINITIONS } from "@/tools/tool-definitions";

const NOW = Date.UTC(2026, 9, 30, 12, 0);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const FILE = `---
name: Authorizations
description: Tasks the user explicitly authorized
---

Some prose before the entries is ignored.

## Tidy the projects folder
- quote: "整理一下 projects 下重复的笔记"
- expires: 2026-11-30
- scope: memory:projects/**
- source: local-conv-abc

## Old task
- quote: merge the old notes
- expires: 2026-10-01
`;

function memoryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "haruyuki-dream-authorization-"));
  roots.push(root);
  return root;
}

function writeMemoryFile(root: string, relative: string, content: string) {
  const segments = relative.split("/");
  mkdirSync(join(root, ...segments.slice(0, -1)), { recursive: true });
  writeFileSync(join(root, ...segments), content);
}

/** A MemFS v1 memory root: no root `MEMORY.md`, core under `system/`. */
function withV1File(relative: string, content: string): string {
  const root = memoryRoot();
  writeMemoryFile(root, relative, content);
  return root;
}

/** A MemFS v2 memory root: the root `MEMORY.md` marker is what makes it v2. */
function withV2File(relative: string, content: string): string {
  const root = memoryRoot();
  writeFileSync(join(root, "MEMORY.md"), "# Memory\n");
  writeMemoryFile(root, relative, content);
  return root;
}

function call(
  args: Parameters<typeof dream_authorization>[0],
  memoryDir: string,
  now = NOW,
) {
  return dream_authorization(args, { agentId: "agent-1", memoryDir, now });
}

describe("resolveAuthorizationCarrierPath", () => {
  test("one carrier per layout, and the other layout's file is never read", () => {
    expect(resolveAuthorizationCarrierPath("memfs-v1")).toBe(
      DREAM_AUTHORIZATION_LEGACY_PATH,
    );
    expect(resolveAuthorizationCarrierPath("memfs-v2")).toBe(
      DREAM_AUTHORIZATION_PATH,
    );
    expect(DREAM_AUTHORIZATION_LEGACY_PATH).toBe("system/authorization.md");
    expect(DREAM_AUTHORIZATION_PATH).toBe("authorization.md");
  });
});

describe("parseDreamAuthorizationEntries", () => {
  test("parses entries after frontmatter and prose", () => {
    const { entries, problems } = parseDreamAuthorizationEntries(FILE);
    expect(problems).toEqual([]);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      title: "Tidy the projects folder",
      line: 8,
      scope: "memory:projects/**",
      expires: "2026-11-30",
      source: "local-conv-abc",
      quote: "整理一下 projects 下重复的笔记",
    });
    // `scope` and `source` are optional: an entry without them still parses.
    expect(entries[1]).toEqual({
      title: "Old task",
      line: 14,
      scope: null,
      expires: "2026-10-01",
      source: null,
      quote: "merge the old notes",
    });
  });

  test("supports never, unquoted quotes and continuation lines", () => {
    const { entries, problems } = parseDreamAuthorizationEntries(`## Permanent
- expires: never
- quote: "do the thing
  and the other thing"
`);
    expect(problems).toEqual([]);
    expect(entries[0]?.expires).toBeNull();
    expect(entries[0]?.scope).toBeNull();
    expect(entries[0]?.source).toBeNull();
    expect(entries[0]?.quote).toContain("do the thing");
    expect(entries[0]?.quote).toContain("and the other thing");
  });

  test("drops an entry missing quote, and says which field is missing", () => {
    const { entries, problems } =
      parseDreamAuthorizationEntries(`## Half an entry
- expires: never
`);
    expect(entries).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("missing required field");
    expect(problems[0]).toContain("quote");
    expect(problems[0]).not.toContain("expires,");
  });

  test("drops an entry missing expires", () => {
    const { entries, problems } = parseDreamAuthorizationEntries(`## No expiry
- quote: do it
`);
    expect(entries).toEqual([]);
    expect(problems[0]).toContain("expires");
    expect(problems[0]).not.toContain("quote,");
  });

  test("drops entries with an invalid expiry", () => {
    const { entries, problems } = parseDreamAuthorizationEntries(`## Bad date
- quote: x
- expires: 2026-02-30
`);
    expect(entries).toEqual([]);
    expect(problems[0]).toContain("invalid `expires`");
  });

  test("quoted-empty required values are missing, not an entry", () => {
    const { entries, problems } = parseDreamAuthorizationEntries(`## Empty quote
- quote: ""
- expires: never
`);
    expect(entries).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("quote");
  });

  test("an empty file is no entries rather than an error", () => {
    expect(parseDreamAuthorizationEntries("")).toEqual({
      entries: [],
      problems: [],
    });
    expect(
      parseDreamAuthorizationEntries("---\nname: x\ndescription: y\n---\n"),
    ).toEqual({ entries: [], problems: [] });
  });
});

describe("isAuthorizationActive", () => {
  test("expires at the end of its UTC day and never means never", () => {
    expect(isAuthorizationActive({ expires: "2026-10-30" }, NOW)).toBe(true);
    expect(isAuthorizationActive({ expires: "2026-10-29" }, NOW)).toBe(false);
    expect(isAuthorizationActive({ expires: null }, NOW)).toBe(true);
    expect(utcDateString(NOW)).toBe("2026-10-30");
  });
});

describe("dream_authorization carrier selection", () => {
  test("a MemFS v2 layout reads the root authorization.md", async () => {
    const root = withV2File(DREAM_AUTHORIZATION_PATH, FILE);
    const result = await call({}, root);
    expect(result.status).toBe("success");
    expect(result.content).toContain(DREAM_AUTHORIZATION_PATH);
    expect(result.content).toContain("Tidy the projects folder");
    expect(result.content).not.toContain(DREAM_AUTHORIZATION_LEGACY_PATH);
  });

  test("a MemFS v1 layout reads system/authorization.md", async () => {
    const root = withV1File(DREAM_AUTHORIZATION_LEGACY_PATH, FILE);
    const result = await call({}, root);
    expect(result.status).toBe("success");
    expect(result.content).toContain(DREAM_AUTHORIZATION_LEGACY_PATH);
    expect(result.content).toContain("Tidy the projects folder");
  });

  test("v2 reads only the root file even when system/authorization.md exists", async () => {
    const root = withV2File(
      DREAM_AUTHORIZATION_PATH,
      FILE.replace("Tidy the projects folder", "Root entry"),
    );
    writeMemoryFile(
      root,
      DREAM_AUTHORIZATION_LEGACY_PATH,
      FILE.replace("Tidy the projects folder", "Legacy entry"),
    );
    const result = await call({}, root);
    expect(result.content).toContain("Root entry");
    expect(result.content).not.toContain("Legacy entry");
  });

  test("v1 reads only system/authorization.md even when authorization.md exists", async () => {
    const root = withV1File(
      DREAM_AUTHORIZATION_LEGACY_PATH,
      FILE.replace("Tidy the projects folder", "Legacy entry"),
    );
    writeMemoryFile(
      root,
      DREAM_AUTHORIZATION_PATH,
      FILE.replace("Tidy the projects folder", "Root entry"),
    );
    const result = await call({}, root);
    expect(result.content).toContain("Legacy entry");
    expect(result.content).not.toContain("Root entry");
  });

  test("a missing v2 carrier names the expected path and does not search", async () => {
    const root = memoryRoot();
    writeFileSync(join(root, "MEMORY.md"), "# Memory\n");
    const result = await call({}, root);
    expect(result.status).toBe("success");
    expect(result.content).toContain("no authorization entries exist");
    expect(result.content).toContain(DREAM_AUTHORIZATION_PATH);
    expect(result.content).toContain("does not exist");
    expect(result.content).toContain("no other location is searched");
    expect(result.content).not.toContain(DREAM_AUTHORIZATION_LEGACY_PATH);
  });

  test("a missing v1 carrier names system/authorization.md", async () => {
    const root = memoryRoot();
    const result = await call({}, root);
    expect(result.status).toBe("success");
    expect(result.content).toContain("no authorization entries exist");
    expect(result.content).toContain(DREAM_AUTHORIZATION_LEGACY_PATH);
    expect(result.content).toContain("no other location is searched");
  });

  test("a v1 root ignores a root-level authorization.md", async () => {
    const root = withV1File(
      DREAM_AUTHORIZATION_PATH,
      FILE.replace("Tidy the projects folder", "Wrong layout entry"),
    );
    const result = await call({}, root);
    expect(result.content).toContain("no authorization entries exist");
    expect(result.content).not.toContain("Wrong layout entry");
  });
});

describe("dream_authorization", () => {
  test("reports active entries with quote, scope and source", async () => {
    const root = withV2File(DREAM_AUTHORIZATION_PATH, FILE);
    const result = await call({}, root);
    expect(result.status).toBe("success");
    expect(result.content).toContain("Tidy the projects folder");
    expect(result.content).toContain("ACTIVE (expires 2026-11-30)");
    expect(result.content).toContain("scope: memory:projects/**");
    expect(result.content).toContain("source: local-conv-abc");
    expect(result.content).toContain("quote: 整理一下 projects 下重复的笔记");
    // Expired entries are hidden by default but counted.
    expect(result.content).not.toContain("Old task");
    expect(result.content).toContain("1 expired entry is not shown");
  });

  test("an entry with only the required fields renders without scope/source", async () => {
    const root = withV2File(
      DREAM_AUTHORIZATION_PATH,
      "## Do it\n- quote: do the thing\n- expires: never\n",
    );
    const result = await call({}, root);
    expect(result.status).toBe("success");
    expect(result.content).toContain("quote: do the thing");
    expect(result.content).not.toContain("scope:");
    expect(result.content).not.toContain("source:");
  });

  test("include_expired lists expired entries with their state", async () => {
    const root = withV2File(DREAM_AUTHORIZATION_PATH, FILE);
    const result = await call({ include_expired: true }, root);
    expect(result.content).toContain("Old task");
    expect(result.content).toContain("EXPIRED on 2026-10-01");
  });

  test("query filters by text", async () => {
    const root = withV2File(DREAM_AUTHORIZATION_PATH, FILE);
    const result = await call({ query: "duplicate" }, root);
    expect(result.content).toContain("no authorization entry");
    expect(result.content).toContain("No authorization");
    expect(result.content).not.toContain("Tidy the projects folder");
  });

  test("query matches title, scope, source and quote case-insensitively", async () => {
    const root = withV2File(DREAM_AUTHORIZATION_PATH, FILE);
    for (const query of ["TIDY", "PROJECTS", "LOCAL-CONV-ABC", "整理"]) {
      const result = await call({ query }, root);
      expect(result.content).toContain("Tidy the projects folder");
    }
  });

  test("an empty carrier authorizes nothing and says so", async () => {
    const root = withV2File(DREAM_AUTHORIZATION_PATH, "");
    const result = await call({}, root);
    expect(result.status).toBe("success");
    expect(result.content).toContain("no active authorization entries");
    expect(result.content).toContain("empty carrier authorizes nothing");
    expect(result.content).toContain("do not search other locations");
  });

  test("malformed entries are reported and authorize nothing", async () => {
    const root = withV2File(
      DREAM_AUTHORIZATION_PATH,
      "## Broken\n- scope: memory:**\n",
    );
    const result = await call({}, root);
    expect(result.content).toContain("no active authorization entries");
    expect(result.content).toContain("malformed entry ignored");
  });

  test("rejects a non-string query", async () => {
    const root = memoryRoot();
    const result = await dream_authorization(
      { query: 42 },
      { agentId: "agent-1", memoryDir: root },
    );
    expect(result.status).toBe("error");
  });

  test("refuses without an agent context", async () => {
    const result = await dream_authorization({}, { memoryDir: memoryRoot() });
    // With a memoryDir but no agent id the tool still cannot know whose
    // authorizations these are; no agent context is an error.
    expect(result.status).toBe("error");
    expect(result.content).toContain("no agent");
  });

  test("the description states the carrier and no-self-authoring disciplines", () => {
    const description = TOOL_DEFINITIONS.DreamAuthorization.description;
    expect(description).toContain("violates the task-tier discipline");
    expect(description).toContain("does not verify the quote");
    expect(description).toContain("No entry means no authorization");
    expect(description).toContain("exactly one carrier per memory layout");
    expect(description).toContain(DREAM_AUTHORIZATION_PATH);
    expect(description).toContain(DREAM_AUTHORIZATION_LEGACY_PATH);
    expect(description).toContain("not a gate");
  });
});
