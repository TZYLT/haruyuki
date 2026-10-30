/**
 * `DreamAuthorization` (F-06 R-5.4.5, Q-18).
 *
 * The important half of this tool is what it says when it finds nothing: "no
 * authorization", never a guess. The parser is exercised directly so a change
 * to the entry convention is visible without a filesystem, and the tool is
 * exercised against a throwaway memory directory.
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
  utcDateString,
} from "@/tools/impl/dream-authorization";

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
- scope: memory:projects/**
- expires: 2026-11-30
- source: local-conv-abc
- quote: "整理一下 projects 下重复的笔记"

## Old task
- scope: workspace:docs/old.md
- expires: 2026-10-01
- source: local-conv-old
- quote: merge the old notes
`;

function memoryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "haruyuki-dream-authorization-"));
  roots.push(root);
  return root;
}

function withFile(relative: string, content: string): string {
  const root = memoryRoot();
  const absolute = join(root, ...relative.split("/"));
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, content);
  return root;
}

function call(
  args: Parameters<typeof dream_authorization>[0],
  memoryDir: string,
  now = NOW,
) {
  return dream_authorization(args, { agentId: "agent-1", memoryDir, now });
}

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
  });

  test("supports never, unquoted quotes and continuation lines", () => {
    const { entries, problems } = parseDreamAuthorizationEntries(`## Permanent
- scope: memory:**
- expires: never
- source: conv-1
- quote: "do the thing
  and the other thing"
`);
    expect(problems).toEqual([]);
    expect(entries[0]?.expires).toBeNull();
    expect(entries[0]?.quote).toContain("do the thing");
    expect(entries[0]?.quote).toContain("and the other thing");
  });

  test("drops entries missing required fields and reports why", () => {
    const { entries, problems } =
      parseDreamAuthorizationEntries(`## Half an entry
- scope: memory:projects
- expires: never
`);
    expect(entries).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("missing required field");
    expect(problems[0]).toContain("source");
    expect(problems[0]).toContain("quote");
  });

  test("drops entries with an invalid expiry", () => {
    const { entries, problems } = parseDreamAuthorizationEntries(`## Bad date
- scope: memory:projects
- expires: 2026-02-30
- source: conv-1
- quote: x
`);
    expect(entries).toEqual([]);
    expect(problems[0]).toContain("invalid `expires`");
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

describe("dream_authorization", () => {
  test("reports active entries with scope, source and quote", async () => {
    const root = withFile(DREAM_AUTHORIZATION_PATH, FILE);
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

  test("include_expired lists expired entries with their state", async () => {
    const root = withFile(DREAM_AUTHORIZATION_PATH, FILE);
    const result = await call({ include_expired: true }, root);
    expect(result.content).toContain("Old task");
    expect(result.content).toContain("EXPIRED on 2026-10-01");
  });

  test("query filters by text", async () => {
    const root = withFile(DREAM_AUTHORIZATION_PATH, FILE);
    const result = await call({ query: "duplicate" }, root);
    expect(result.content).toContain("no authorization entry");
    expect(result.content).toContain("No authorization");
    expect(result.content).not.toContain("Tidy the projects folder");
  });

  test("query matches title, scope, source and quote case-insensitively", async () => {
    const root = withFile(DREAM_AUTHORIZATION_PATH, FILE);
    for (const query of ["TIDY", "PROJECTS", "LOCAL-CONV-ABC", "整理"]) {
      const result = await call({ query }, root);
      expect(result.content).toContain("Tidy the projects folder");
    }
  });

  test("no file means no authorization, explicitly", async () => {
    const root = memoryRoot();
    const result = await call({}, root);
    expect(result.status).toBe("success");
    expect(result.content).toContain("no authorization entries exist");
    expect(result.content).toContain("No authorization");
    expect(result.content).toContain("do not infer");
  });

  test("the legacy system/ path is read when the root file is absent", async () => {
    const root = withFile(DREAM_AUTHORIZATION_LEGACY_PATH, FILE);
    const result = await call({}, root);
    expect(result.content).toContain(DREAM_AUTHORIZATION_LEGACY_PATH);
    expect(result.content).toContain("Tidy the projects folder");
  });

  test("the root file wins over the legacy file", async () => {
    const root = withFile(
      DREAM_AUTHORIZATION_LEGACY_PATH,
      FILE.replace("Tidy the projects folder", "Legacy entry"),
    );
    writeFileSync(
      join(root, DREAM_AUTHORIZATION_PATH),
      FILE.replace("Tidy the projects folder", "Root entry"),
    );
    const result = await call({}, root);
    expect(result.content).toContain("Root entry");
    expect(result.content).not.toContain("Legacy entry");
  });

  test("malformed entries are reported and authorize nothing", async () => {
    const root = withFile(
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
});
