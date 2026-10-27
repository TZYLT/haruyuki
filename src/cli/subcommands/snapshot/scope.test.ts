import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { TestDirectory } from "@/test-utils/test-fs";
import { APP_DIR_NAME, APP_SUBDIRS, appHomeRoot } from "@/utils/app-paths";
import { getLocalBackendStorageDir } from "@/utils/local-backend-paths";
import type { CollectEntriesOptions, ScopeEntry, ScopeRoots } from "./scope";
import {
  assertNoCaseCollision,
  collectEntries,
  literalHomeBase,
  matchesScopePattern,
  resolveHomeRoots,
  SCOPE_RULES,
  scopeExclusions,
  usesLiteralHomeRoot,
} from "./scope";
import type { SnapshotExclusion, SnapshotScope } from "./types";
import { SnapshotError } from "./types";

/* ------------------------------------------------------------------ */
/* Isolation                                                            */
/* ------------------------------------------------------------------ */

const initialHaruyukiHome = process.env.HARUYUKI_HOME;
const initialLocalBackendDir = process.env.LETTA_LOCAL_BACKEND_DIR;
const temporaryTrees: TestDirectory[] = [];

function makeTree(): TestDirectory {
  const tree = new TestDirectory();
  temporaryTrees.push(tree);
  return tree;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restoreEnv("HARUYUKI_HOME", initialHaruyukiHome);
  restoreEnv("LETTA_LOCAL_BACKEND_DIR", initialLocalBackendDir);
  for (const tree of temporaryTrees.splice(0)) tree.cleanup();
});

/* ------------------------------------------------------------------ */
/* The table, asserted row by row                                       */
/* ------------------------------------------------------------------ */

interface ExpectedRule {
  pattern: string;
  scope: SnapshotScope;
  reason: string;
  nestedExcludes?: readonly string[];
}

const EXPECTED_INCLUDE: readonly ExpectedRule[] = [
  {
    pattern: "home/settings.json",
    scope: "home",
    reason:
      "global settings: permissions, sessionsByServer and recentModels (packaged as the sanitised copy)",
  },
  {
    pattern: "home/settings.local.json",
    scope: "home",
    reason:
      "root-level local settings, written when the working directory is the harness root",
  },
  {
    pattern: "home/sessions.jsonl",
    scope: "home",
    reason: "session start/stop ledger; /resume history depends on it",
  },
  {
    pattern: "home/crons.json",
    scope: "home",
    reason: "cron definitions; the scheduler lease is cleared on import",
  },
  {
    pattern: "home/runs/**",
    scope: "home",
    reason: "cron run logs, trimmed per task",
  },
  {
    pattern: "home/usage/**",
    scope: "home",
    reason: "per-turn usage ledger; it cannot be rebuilt from conversations",
  },
  {
    pattern: "home/transcripts/**",
    scope: "home",
    reason: "reflection and subagent transcripts, including background/",
  },
  {
    pattern: "home/channels/**",
    scope: "home",
    reason: "channel accounts plus the WhatsApp session credentials",
  },
  {
    pattern: "home/skills/**",
    scope: "home",
    reason: "global skills",
  },
  {
    pattern: "home/commands/**",
    scope: "home",
    reason: "custom slash commands",
  },
  {
    pattern: "home/mods/**",
    scope: "home",
    reason: "user mod sources; the diagnostics sub-tree is derived",
    nestedExcludes: ["diagnostics"],
  },
  {
    pattern: "home/extensions/**",
    scope: "home",
    reason: "legacy extensions, when present",
  },
  {
    pattern: "home/agents/**",
    scope: "home",
    reason: "pre-experimental memory roots and agent directories, when present",
  },
  {
    pattern: "local-backend/agents/*.json",
    scope: "local-backend",
    reason: "agent records: name, model, model_settings, personality",
  },
  {
    pattern: "local-backend/conversations/*/conversation.json",
    scope: "local-backend",
    reason: "conversation record",
  },
  {
    pattern: "local-backend/conversations/*/manifest.json",
    scope: "local-backend",
    reason: "transcript schema and format version",
  },
  {
    pattern: "local-backend/conversations/*/messages.jsonl",
    scope: "local-backend",
    reason: "the only real message log",
  },
  {
    pattern: "local-backend/memfs/*/memory/**",
    scope: "local-backend",
    reason: "memory repository including .git and its full history",
  },
  {
    pattern: "local-backend/providers/auth.json",
    scope: "local-backend",
    reason: "provider API keys and OAuth tokens",
  },
  // C. project tree: the narrow §5.3 C list (2026-10-26 ruling), NOT a mirror of
  // the checkout — source files and `.env` must stay out.
  {
    pattern: "project/.haruyuki/settings.json",
    scope: "project",
    reason: "project-level settings that belong to this checkout",
  },
  {
    pattern: "project/.haruyuki/settings.local.json",
    scope: "project",
    reason: "project-level local settings, when present",
  },
  {
    pattern: "project/.haruyukiignore",
    scope: "project",
    reason: "the project's own ignore file, read by the harness",
  },
  {
    pattern: "project/.commands/**",
    scope: "project",
    reason: "project-level custom slash commands",
  },
  {
    pattern: "project/.agents/skills/**",
    scope: "project",
    reason: "project-level skills",
  },
  {
    pattern: "project/.skills/**",
    scope: "project",
    reason: "legacy project-level skills directory, when present",
  },
  {
    pattern: "secrets.json",
    scope: "secrets",
    reason: "settings tokens, agent secrets and channel credentials",
  },
];

const EXPECTED_EXCLUDE: readonly ExpectedRule[] = [
  {
    pattern: "local-backend/agents/*.topics.json",
    scope: "local-backend",
    reason:
      "per-agent topic index: derived from the transcripts and rebuilt on demand, so a package must not carry it (or the agent id the file name would imply)",
  },
  {
    pattern: "home/logs/**",
    scope: "home",
    reason:
      "debug, feedback and boundary-error logs: voluminous and useless elsewhere",
  },
  {
    pattern: "home/cache/**",
    scope: "home",
    reason: "derived cache, rebuilt on demand",
  },
  {
    pattern: "home/mod-cache/**",
    scope: "home",
    reason: "compiled mod cache, derived",
  },
  {
    pattern: "home/bin/**",
    scope: "home",
    reason: "downloaded tool binaries, platform specific",
  },
  {
    pattern: "home/viewers/**",
    scope: "home",
    reason: "generated HTML viewers",
  },
  {
    pattern: "home/artifacts/**",
    scope: "home",
    reason: "generated artifact files",
  },
  {
    pattern: "home/workflows/**",
    scope: "home",
    reason: "workflow execution output: scripts, parameters and journal",
  },
  {
    pattern: "home/notifications/**",
    scope: "home",
    reason: "toast history, capped and disposable",
  },
  {
    pattern: "home/projects/**",
    scope: "home",
    reason:
      "per-project agent-tools spill and derived state; appendix B excludes the whole tree",
  },
  {
    pattern: "home/plans/**",
    scope: "home",
    reason: "declared but unconsumed",
  },
  {
    pattern: "home/worktrees/**",
    scope: "home",
    reason: "git-bound managed worktrees",
  },
  {
    pattern: "home/backups/**",
    scope: "home",
    reason:
      "our own pre-import backups; excluding them keeps a package from nesting inside the next",
  },
  {
    pattern: "local-backend/conversations/*/system-prompt.json",
    scope: "local-backend",
    reason: "compiled snapshot, derived",
  },
  {
    pattern: "local-backend/conversations/*/recall-index.json",
    scope: "local-backend",
    reason: "recall index, derived",
  },
  {
    pattern: "local-backend/conversations/*/messages.jsonl.pre-pi-backup-*",
    scope: "local-backend",
    reason: "one-off migration backup",
  },
  {
    pattern: "local-backend/memfs/*/memory-worktrees/**",
    scope: "local-backend",
    reason: "temporary git worktrees",
  },
  {
    pattern: "local-backend/secrets/local-agent-secrets.json",
    scope: "local-backend",
    reason:
      "agent secret values travel in secrets.json; shipping the file too would create two copies",
  },
  {
    pattern: "project/.haruyuki/worktrees/**",
    scope: "project",
    reason: "git-bound managed worktrees",
  },
  {
    pattern: "project/.git/**",
    scope: "project",
    reason: "git metadata belongs to the project, not to the snapshot",
  },
  {
    pattern: "project/node_modules/**",
    scope: "project",
    reason: "dependencies are reinstalled, not shipped",
  },
];

function assertRuleTable(
  rules: readonly ExpectedRule[],
  include: boolean,
): void {
  const actual = SCOPE_RULES.filter((rule) => rule.include === include);
  expect(actual).toHaveLength(rules.length);
  for (const expected of rules) {
    const rule = SCOPE_RULES.find(
      (candidate) => candidate.pattern === expected.pattern,
    );
    expect(rule, `missing rule for ${expected.pattern}`).toBeDefined();
    expect(rule?.include).toBe(include);
    expect(rule?.scope).toBe(expected.scope);
    expect(rule?.reason).toBe(expected.reason);
    expect(rule?.nestedExcludes).toEqual(expected.nestedExcludes);
  }
}

test("SCOPE_RULES: the 26 include rules, asserted one by one", () => {
  assertRuleTable(EXPECTED_INCLUDE, true);
});

test("SCOPE_RULES: the 21 exclude rules, asserted one by one", () => {
  assertRuleTable(EXPECTED_EXCLUDE, false);
});

test("SCOPE_RULES: 47 unique rows, each filed under its own scope", () => {
  expect(SCOPE_RULES).toHaveLength(47);
  expect(new Set(SCOPE_RULES.map((rule) => rule.pattern)).size).toBe(47);
  for (const rule of SCOPE_RULES) {
    const prefix = rule.scope === "secrets" ? "secrets.json" : rule.scope;
    expect(
      rule.pattern === prefix || rule.pattern.startsWith(`${prefix}/`),
      `${rule.pattern} is filed under ${rule.scope}`,
    ).toBe(true);
    expect(rule.reason.length).toBeGreaterThan(0);
  }
});

test("scopeExclusions: the 21 exclude rows in table order", () => {
  const exclusions = scopeExclusions();
  expect(exclusions).toHaveLength(21);
  expect(exclusions).toEqual(
    SCOPE_RULES.filter((rule) => !rule.include).map((rule) => ({
      path: rule.pattern,
      reason: rule.reason,
    })),
  );
  expect(exclusions.map((exclusion) => exclusion.path)).toEqual(
    EXPECTED_EXCLUDE.map((rule) => rule.pattern),
  );
});

/* ------------------------------------------------------------------ */
/* Fixture                                                              */
/* ------------------------------------------------------------------ */

function writeFileAt(root: string, relativePath: string, content = "x"): void {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf-8");
}

interface Fixture {
  tree: TestDirectory;
  roots: ScopeRoots;
  /** Literal `homedir()` root of this fixture (not the app home root). */
  literalHomeRoot: string;
  literalHome: string;
  project: string;
}

/**
 * One agent, two conversations, one memory repository with `.git`, a cron file,
 * every include subtree, and one file under every excluded path — so each rule
 * can be exercised by pattern rather than by total count.
 */
function createFixture(): Fixture {
  const tree = makeTree();
  const appHome = join(tree.path, "app-home");
  const storageDir = join(tree.path, "storage");
  const literalHomeRoot = join(tree.path, "home");
  const literalHome = join(literalHomeRoot, APP_DIR_NAME);
  const project = join(tree.path, "repo");

  // A. home root, app home family
  writeFileAt(appHome, APP_SUBDIRS.settingsFile, '{"permissions":{}}');
  writeFileAt(appHome, APP_SUBDIRS.localSettingsFile, "{}");
  writeFileAt(appHome, "sessions.jsonl", '{"id":"session-1"}\n');
  writeFileAt(appHome, "crons.json", '{"tasks":[]}');
  writeFileAt(appHome, join("runs", "task-1", "run-1.log"), "ran");
  writeFileAt(appHome, join(APP_SUBDIRS.usage, "ledger.jsonl"), "{}\n");
  writeFileAt(appHome, join(APP_SUBDIRS.skills, "alpha.md"), "alpha");
  writeFileAt(appHome, join(APP_SUBDIRS.skills, "Zebra.md"), "zebra");
  writeFileAt(appHome, join(APP_SUBDIRS.commands, "deploy.md"), "deploy");
  writeFileAt(appHome, join(APP_SUBDIRS.mods, "custom.ts"), "export {};");
  writeFileAt(
    appHome,
    join(APP_SUBDIRS.mods, "nested", "deep.ts"),
    "export {};",
  );
  writeFileAt(
    appHome,
    join(APP_SUBDIRS.mods, "diagnostics", "report.json"),
    "{}",
  );
  writeFileAt(appHome, join(APP_SUBDIRS.extensions, "legacy.ts"), "export {};");
  writeFileAt(appHome, join(APP_SUBDIRS.agents, "old-agent.json"), "{}");

  // A. home root, literal-homedir family (channels + WhatsApp auth + transcripts)
  writeFileAt(
    literalHome,
    join(APP_SUBDIRS.channels, "whatsapp", "accounts.json"),
    "{}",
  );
  writeFileAt(
    literalHome,
    join(APP_SUBDIRS.channels, "whatsapp", "auth", "acct-1", "creds.json"),
    "{}",
  );
  writeFileAt(
    literalHome,
    join(APP_SUBDIRS.transcripts, "background", "bg.jsonl"),
    "{}\n",
  );
  // The app-home copies must never be read: these two entries follow the literal root.
  writeFileAt(appHome, join(APP_SUBDIRS.channels, "decoy.json"), "{}");
  writeFileAt(appHome, join(APP_SUBDIRS.transcripts, "decoy.jsonl"), "{}\n");

  // A. the excluded home paths, one file each
  const excludedHome: ReadonlyArray<readonly [string, string]> = [
    [APP_SUBDIRS.logs, join("debug", "debug.log")],
    [APP_SUBDIRS.cache, "index.bin"],
    [APP_SUBDIRS.modCache, "mods.json"],
    [APP_SUBDIRS.bin, "rg.exe"],
    [APP_SUBDIRS.viewers, "viewer.html"],
    [APP_SUBDIRS.artifacts, "artifact.png"],
    [APP_SUBDIRS.workflows, join("executions", "1", "journal.json")],
    [APP_SUBDIRS.notifications, "message-history.jsonl"],
    [join("projects", "repo-a", "agent-tools"), "spill.txt"],
    [APP_SUBDIRS.plans, "plan.md"],
    [APP_SUBDIRS.worktrees, join("wt-a", "draft.md")],
    ["backups", "pre-import.hryk"],
  ];
  for (const [directory, file] of excludedHome) {
    writeFileAt(appHome, join(directory, file), "excluded");
  }

  // B. storage root
  writeFileAt(storageDir, join("agents", "agent-1.json"), '{"id":"agent-1"}');
  // F-04's per-agent topic index: derived, so the walk must skip and report it.
  writeFileAt(
    storageDir,
    join("agents", "agent-1.topics.json"),
    '{"agentId":"agent-1","conversations":{}}',
  );
  for (const key of ["conversation-1", "conversation-2"]) {
    writeFileAt(
      storageDir,
      join("conversations", key, "conversation.json"),
      `{"id":"${key}"}`,
    );
    writeFileAt(storageDir, join("conversations", key, "manifest.json"), "{}");
    writeFileAt(
      storageDir,
      join("conversations", key, "messages.jsonl"),
      "{}\n",
    );
    writeFileAt(
      storageDir,
      join("conversations", key, "system-prompt.json"),
      "{}",
    );
    writeFileAt(
      storageDir,
      join("conversations", key, "recall-index.json"),
      "{}",
    );
    writeFileAt(
      storageDir,
      join("conversations", key, "messages.jsonl.pre-pi-backup-1"),
      "{}\n",
    );
  }
  writeFileAt(
    storageDir,
    join("memfs", "agent-1", "memory", "README.md"),
    "# memory",
  );
  writeFileAt(
    storageDir,
    join("memfs", "agent-1", "memory", ".git", "HEAD"),
    "ref: main",
  );
  writeFileAt(
    storageDir,
    join("memfs", "agent-1", "memory", ".git", "refs", "heads", "main"),
    "deadbeef",
  );
  writeFileAt(
    storageDir,
    join("memfs", "agent-1", "memory-worktrees", "wt-1", "draft.md"),
    "draft",
  );
  writeFileAt(storageDir, join("providers", "auth.json"), "{}");
  writeFileAt(
    storageDir,
    join("secrets", "local-agent-secrets.json"),
    '{"agent:1":"value"}',
  );

  // C. project tree: the six narrow §5.3 C items in, everything else out.
  writeFileAt(project, join(APP_DIR_NAME, "settings.json"), "{}");
  writeFileAt(project, join(APP_DIR_NAME, "settings.local.json"), "{}");
  writeFileAt(project, ".haruyukiignore", "ignored");
  writeFileAt(project, join(".commands", "ship.md"), "ship");
  writeFileAt(
    project,
    join(".agents", "skills", "project-skill", "SKILL.md"),
    "# skill",
  );
  writeFileAt(project, join(".skills", "legacy-skill", "SKILL.md"), "# legacy");
  // Never carried: source, secrets and the three excluded project paths.
  writeFileAt(project, join("src", "index.ts"), "export {};");
  writeFileAt(project, ".env", "OPENAI_API_KEY=placeholder");
  writeFileAt(
    project,
    join(APP_DIR_NAME, "worktrees", "wt-1", "draft.md"),
    "draft",
  );
  writeFileAt(project, join(".git", "HEAD"), "ref: main");
  writeFileAt(project, join("node_modules", "left-pad", "index.js"), "module");

  return {
    tree,
    roots: { appHome, storageDir, homedirRoot: literalHomeRoot },
    literalHomeRoot,
    literalHome,
    project,
  };
}

async function collectAll(
  roots: ScopeRoots,
  opts: CollectEntriesOptions = {},
): Promise<ScopeEntry[]> {
  const entries: ScopeEntry[] = [];
  for await (const entry of collectEntries(roots, opts)) entries.push(entry);
  return entries;
}

function paths(entries: readonly ScopeEntry[]): string[] {
  return entries.map((entry) => entry.path);
}

/* ------------------------------------------------------------------ */
/* Root resolution                                                      */
/* ------------------------------------------------------------------ */

test("resolveHomeRoots: defaults follow the app home and the local backend root", () => {
  delete process.env.HARUYUKI_HOME;
  delete process.env.LETTA_LOCAL_BACKEND_DIR;
  const roots = resolveHomeRoots();
  expect(roots.appHome).toBe(appHomeRoot());
  // The preload redirects HOME, and appHomeRoot follows it on every call.
  expect(roots.appHome.startsWith(process.env.HOME ?? "\u0000")).toBe(true);
  expect(roots.storageDir).toBe(getLocalBackendStorageDir());
  expect(roots.homedirRoot).toBe(homedir());
});

test("resolveHomeRoots: HARUYUKI_HOME moves appHome and the derived storage root only", () => {
  const redirected = join(makeTree().path, "redirected-home");
  process.env.HARUYUKI_HOME = redirected;
  delete process.env.LETTA_LOCAL_BACKEND_DIR;
  const roots = resolveHomeRoots();
  expect(roots.appHome).toBe(redirected);
  expect(roots.storageDir).toBe(join(redirected, APP_SUBDIRS.localBackend));
  expect(roots.storageDir).toBe(getLocalBackendStorageDir());
  // The literal root never follows the override: channels/, transcripts/ and the
  // WhatsApp auth files stay where the app writes them.
  expect(roots.homedirRoot).toBe(homedir());
  expect(roots.homedirRoot).not.toBe(redirected);
});

test("resolveHomeRoots: LETTA_LOCAL_BACKEND_DIR wins over the derived root", () => {
  const explicit = join(makeTree().path, "backend-root");
  process.env.HARUYUKI_HOME = join(makeTree().path, "redirected-home");
  process.env.LETTA_LOCAL_BACKEND_DIR = explicit;
  const roots = resolveHomeRoots();
  expect(roots.storageDir).toBe(explicit);
});

test("resolveHomeRoots: deps override the roots independently and homedirRoot stays literal", () => {
  delete process.env.HARUYUKI_HOME;
  delete process.env.LETTA_LOCAL_BACKEND_DIR;
  const tree = makeTree();
  const customHome = join(tree.path, "deps-home");
  const customStorage = join(tree.path, "deps-storage");

  const withBoth = resolveHomeRoots({
    homeRoot: customHome,
    storageDir: customStorage,
  });
  expect(withBoth.appHome).toBe(customHome);
  expect(withBoth.storageDir).toBe(customStorage);
  expect(withBoth.homedirRoot).toBe(homedir());

  // homeRoot alone does not relocate the local backend (Lead ruling, M2).
  const withHomeOnly = resolveHomeRoots({ homeRoot: customHome });
  expect(withHomeOnly.appHome).toBe(customHome);
  expect(withHomeOnly.storageDir).toBe(getLocalBackendStorageDir());
  expect(withHomeOnly.storageDir.startsWith(customHome)).toBe(false);

  // deps won over the ambient HARUYUKI_HOME.
  process.env.HARUYUKI_HOME = join(tree.path, "ambient-home");
  expect(resolveHomeRoots({ homeRoot: customHome }).appHome).toBe(customHome);
});

test("literalHomeBase: the channels/transcripts base, and never HARUYUKI_HOME", () => {
  const tree = makeTree();
  const roots: ScopeRoots = {
    appHome: join(tree.path, "app-home"),
    storageDir: join(tree.path, "storage"),
    homedirRoot: join(tree.path, "home"),
  };
  expect(literalHomeBase(roots)).toBe(join(roots.homedirRoot, APP_DIR_NAME));
  expect(literalHomeBase(roots).startsWith(roots.appHome)).toBe(false);

  // Resolved live: the ambient override moves appHome and leaves this base put,
  // which is exactly why the import side must not land channels there.
  process.env.HARUYUKI_HOME = join(tree.path, "redirected-home");
  const ambient = resolveHomeRoots();
  expect(literalHomeBase(ambient)).toBe(join(homedir(), APP_DIR_NAME));
  expect(ambient.appHome).not.toBe(literalHomeBase(ambient));
});

test("usesLiteralHomeRoot: exactly channels/ and transcripts/, driven by one table", () => {
  expect(usesLiteralHomeRoot("home/channels")).toBe(true);
  expect(
    usesLiteralHomeRoot("home/channels/whatsapp/auth/acct-1/creds.json"),
  ).toBe(true);
  expect(usesLiteralHomeRoot("home/transcripts/background/bg.jsonl")).toBe(
    true,
  );
  expect(usesLiteralHomeRoot("home/settings.json")).toBe(false);
  expect(usesLiteralHomeRoot("home/logs/debug.log")).toBe(false);
  // Case-sensitive: the app writes these two names in lower case.
  expect(usesLiteralHomeRoot("home/Channels/whatsapp")).toBe(false);
  expect(usesLiteralHomeRoot("local-backend/agents/agent-1.json")).toBe(false);
  expect(usesLiteralHomeRoot("project/.haruyukiignore")).toBe(false);
  expect(usesLiteralHomeRoot("home")).toBe(false);
  expect(usesLiteralHomeRoot("")).toBe(false);

  // The walk reads the same table: only those rows resolve from the literal base.
  const literalRules = SCOPE_RULES.filter(
    (rule) => rule.include && usesLiteralHomeRoot(rule.pattern),
  ).map((rule) => rule.pattern);
  expect(literalRules).toEqual(["home/transcripts/**", "home/channels/**"]);
});

/* ------------------------------------------------------------------ */
/* Traversal: every rule exercised                                      */
/* ------------------------------------------------------------------ */

test("collectEntries: all 20 walked include rules contribute entries in their own scope", async () => {
  const fixture = createFixture();
  const entries = await collectAll(fixture.roots, { project: fixture.project });
  for (const rule of SCOPE_RULES) {
    if (!rule.include || rule.scope === "secrets") continue;
    const matched = entries.filter((entry) =>
      matchesScopePattern(rule.pattern, entry.path),
    );
    expect(matched.length, `no entry for ${rule.pattern}`).toBeGreaterThan(0);
    for (const entry of matched) {
      expect(entry.scope).toBe(rule.scope);
      expect(entry.absolutePath.length).toBeGreaterThan(0);
    }
  }
  // secrets.json is written by the packer, never walked from disk.
  expect(paths(entries)).not.toContain("secrets.json");
  expect(entries.some((entry) => entry.scope === "secrets")).toBe(false);
});

test("collectEntries: no excluded path is ever yielded, and each rule reports the skip", async () => {
  const fixture = createFixture();
  const excluded: SnapshotExclusion[] = [];
  const entries = await collectAll(fixture.roots, {
    project: fixture.project,
    onExcluded: (exclusion) => excluded.push(exclusion),
  });
  // One row prunes by never listing the directory that holds it: no include row
  // walks `local-backend/secrets/`, so its content is never named. Everything
  // else is a sibling of an included path and is therefore seen and reported.
  const notVisited = new Set([
    "local-backend/secrets/local-agent-secrets.json",
  ]);
  for (const rule of SCOPE_RULES) {
    if (rule.include) continue;
    expect(
      entries.some((entry) => matchesScopePattern(rule.pattern, entry.path)),
      `excluded path leaked into the package: ${rule.pattern}`,
    ).toBe(false);
    const reported = excluded.some((exclusion) =>
      matchesScopePattern(rule.pattern, exclusion.path),
    );
    if (notVisited.has(rule.pattern)) {
      expect(reported, `unexpected report for ${rule.pattern}`).toBe(false);
    } else {
      expect(reported, `no exclusion reported for ${rule.pattern}`).toBe(true);
      const record = excluded.find((exclusion) =>
        matchesScopePattern(rule.pattern, exclusion.path),
      );
      expect(record?.reason).toBe(rule.reason);
    }
  }
  const nestedPatterns = SCOPE_RULES.flatMap((rule) =>
    (rule.nestedExcludes ?? []).map(
      (nested) =>
        `${rule.pattern.split("/").slice(0, -1).join("/")}/${nested}/**`,
    ),
  );
  for (const exclusion of excluded) {
    const explained =
      SCOPE_RULES.some(
        (rule) =>
          !rule.include && matchesScopePattern(rule.pattern, exclusion.path),
      ) ||
      nestedPatterns.some((pattern) =>
        matchesScopePattern(pattern, exclusion.path),
      );
    expect(
      explained,
      `reported a path that no rule excludes: ${exclusion.path}`,
    ).toBe(true);
  }
});

test("collectEntries: mods/diagnostics is pruned from the mods subtree", async () => {
  const fixture = createFixture();
  const excluded: SnapshotExclusion[] = [];
  const entries = await collectAll(fixture.roots, {
    project: fixture.project,
    onExcluded: (exclusion) => excluded.push(exclusion),
  });
  const found = paths(entries);
  expect(found).toContain("home/mods/custom.ts");
  expect(found).toContain("home/mods/nested/deep.ts");
  expect(found.some((path) => path.startsWith("home/mods/diagnostics"))).toBe(
    false,
  );
  expect(excluded.map((exclusion) => exclusion.path)).toContain(
    "home/mods/diagnostics",
  );
});

/* ------------------------------------------------------------------ */
/* Boundaries                                                           */
/* ------------------------------------------------------------------ */

test("collectEntries: sessions.jsonl, root settings.local.json and the memory .git are carried", async () => {
  const fixture = createFixture();
  const found = paths(
    await collectAll(fixture.roots, { project: fixture.project }),
  );
  // Both files sit outside APP_SUBDIRS, which is why the include table names them.
  expect(found).toContain("home/sessions.jsonl");
  expect(found).toContain("home/settings.local.json");
  expect(found).toContain("home/settings.json");
  expect(found).toContain("local-backend/memfs/agent-1/memory/.git/HEAD");
  expect(found).toContain(
    "local-backend/memfs/agent-1/memory/.git/refs/heads/main",
  );
  for (const key of ["conversation-1", "conversation-2"]) {
    expect(found).toContain(
      `local-backend/conversations/${key}/conversation.json`,
    );
    expect(found).toContain(
      `local-backend/conversations/${key}/messages.jsonl`,
    );
  }
});

test("collectEntries: projects/ and backups/ never enter the package", async () => {
  const fixture = createFixture();
  const found = paths(
    await collectAll(fixture.roots, { project: fixture.project }),
  );
  // Appendix B + ruling 6 exclude the whole projects/ tree; the narrower
  // agent-tools-only line in the requirement's §5.3 table does not apply.
  expect(found.some((path) => path.startsWith("home/projects"))).toBe(false);
  expect(found.some((path) => path.startsWith("home/backups"))).toBe(false);
  expect(found.some((path) => path === "home/backups/pre-import.hryk")).toBe(
    false,
  );
});

test("collectEntries: the project tree carries the six narrow items only", async () => {
  const fixture = createFixture();
  const found = paths(
    await collectAll(fixture.roots, { project: fixture.project }),
  );
  // The §5.3 C list, one assertion per row.
  expect(found).toContain("project/.haruyuki/settings.json");
  expect(found).toContain("project/.haruyuki/settings.local.json");
  expect(found).toContain("project/.haruyukiignore");
  expect(found).toContain("project/.commands/ship.md");
  expect(found).toContain("project/.agents/skills/project-skill/SKILL.md");
  expect(found).toContain("project/.skills/legacy-skill/SKILL.md");
  // Not a mirror of the checkout: source, `.env` and the excluded trees stay out,
  // and the project root is not an entry of its own any more.
  expect(found).not.toContain("project/src/index.ts");
  expect(found).not.toContain("project/.env");
  expect(found).not.toContain("project");
  expect(found.some((path) => path.startsWith("project/.git"))).toBe(false);
  expect(found.some((path) => path.startsWith("project/node_modules"))).toBe(
    false,
  );
  expect(
    found.some((path) => path.startsWith("project/.haruyuki/worktrees")),
  ).toBe(false);

  // Without --with-project the third tree contributes nothing at all.
  const withoutProject = paths(await collectAll(fixture.roots));
  expect(withoutProject.some((path) => path.startsWith("project"))).toBe(false);
});

test("collectEntries: channels and transcripts come from the literal home root", async () => {
  const fixture = createFixture();
  const found = paths(
    await collectAll(fixture.roots, { project: fixture.project }),
  );
  expect(found).toContain("home/channels/whatsapp/accounts.json");
  expect(found).toContain("home/channels/whatsapp/auth/acct-1/creds.json");
  expect(found).toContain("home/transcripts/background/bg.jsonl");
  // The app-home decoys prove the root family split: a run that relocates only
  // HARUYUKI_HOME still reads these two entries from the real home directory.
  expect(found).not.toContain("home/channels/decoy.json");
  expect(found).not.toContain("home/transcripts/decoy.jsonl");
});

test("collectEntries: each home entry resolves from the base its own rule names", async () => {
  const fixture = createFixture();
  // The fixture keeps homedirRoot and appHome disjoint, so a mismatch cannot hide.
  expect(fixture.roots.homedirRoot).not.toBe(fixture.roots.appHome);
  const base = literalHomeBase(fixture.roots);
  const entries = await collectAll(fixture.roots, { project: fixture.project });
  const homeEntries = entries.filter((entry) => entry.path.startsWith("home/"));
  expect(homeEntries.length).toBeGreaterThan(0);

  const literal = homeEntries.filter((entry) =>
    usesLiteralHomeRoot(entry.path),
  );
  expect(literal.length).toBeGreaterThan(0);
  for (const entry of homeEntries) {
    if (usesLiteralHomeRoot(entry.path)) {
      expect(
        entry.absolutePath.startsWith(base),
        `${entry.path} should come from ${base}`,
      ).toBe(true);
      expect(entry.absolutePath.startsWith(fixture.roots.appHome)).toBe(false);
    } else {
      expect(
        entry.absolutePath.startsWith(fixture.roots.appHome),
        `${entry.path} should come from ${fixture.roots.appHome}`,
      ).toBe(true);
    }
  }
});

/* ------------------------------------------------------------------ */
/* Ordering, sizing, collisions                                         */
/* ------------------------------------------------------------------ */

function expectUtf8Sorted(list: readonly string[]): void {
  const sorted = [...list].sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
  );
  expect(list).toEqual(sorted);
}

test("collectEntries: trees come in package order and each is byte-sorted", async () => {
  const fixture = createFixture();
  const entries = await collectAll(fixture.roots, { project: fixture.project });
  const found = paths(entries);
  const home = found.filter((path) => path.startsWith("home/"));
  const storage = found.filter((path) => path.startsWith("local-backend/"));
  const project = found.filter(
    (path) => path === "project" || path.startsWith("project/"),
  );
  expect(found).toEqual([...home, ...storage, ...project]);
  expectUtf8Sorted(home);
  expectUtf8Sorted(storage);
  expectUtf8Sorted(project);

  // Byte order, not locale order: "Z" (0x5A) sorts before "a" (0x61).
  expect(found.indexOf("home/skills/Zebra.md")).toBeLessThan(
    found.indexOf("home/skills/alpha.md"),
  );
});

test("collectEntries: two walks of the same tree produce the same list", async () => {
  const fixture = createFixture();
  const first = await collectAll(fixture.roots, { project: fixture.project });
  const second = await collectAll(fixture.roots, { project: fixture.project });
  expect(second.map((entry) => entry.path)).toEqual(
    first.map((entry) => entry.path),
  );
  expect(second).toEqual(first);
});

test("collectEntries: files carry their byte size and directories carry zero", async () => {
  const fixture = createFixture();
  const entries = await collectAll(fixture.roots, { project: fixture.project });
  const readme = entries.find(
    (entry) => entry.path === "local-backend/memfs/agent-1/memory/README.md",
  );
  expect(readme?.kind).toBe("file");
  expect(readme?.bytes).toBe(Buffer.byteLength("# memory"));
  const runsDirectory = entries.find((entry) => entry.path === "home/runs");
  expect(runsDirectory?.kind).toBe("dir");
  expect(runsDirectory?.bytes).toBe(0);
});

test("collectEntries: missing roots are empty, not an error", async () => {
  const tree = makeTree();
  const roots: ScopeRoots = {
    appHome: join(tree.path, "no-app-home"),
    storageDir: join(tree.path, "no-storage"),
    homedirRoot: join(tree.path, "no-home"),
  };
  expect(await collectAll(roots)).toEqual([]);
  expect(
    await collectAll(roots, { project: join(tree.path, "no-project") }),
  ).toEqual([]);
});

test("assertNoCaseCollision: case-only siblings abort with path_conflict", () => {
  let thrown: unknown;
  try {
    assertNoCaseCollision(join(makeTree().path, "case-dir"), ["Logs", "logs"]);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(SnapshotError);
  expect((thrown as SnapshotError).code).toBe("path_conflict");
  expect((thrown as Error).message).toContain("Logs");
  expect((thrown as Error).message).toContain("logs");

  // The same name twice, or two unrelated names, is not a collision.
  expect(() =>
    assertNoCaseCollision("case-dir", ["logs", "logs"]),
  ).not.toThrow();
  expect(() =>
    assertNoCaseCollision("case-dir", ["logs", "logs-2"]),
  ).not.toThrow();
});
