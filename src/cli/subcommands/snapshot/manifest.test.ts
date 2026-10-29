import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TestDirectory } from "@/test-utils/test-fs";
import {
  buildManifest,
  checkVersion,
  MANIFEST_MIGRATIONS,
  parseManifest,
  serializeManifest,
  verifyManifest,
} from "./manifest";
import { collectEntries, DIRECTORY_ENTRY_SHA256, SCOPE_RULES } from "./scope";
import type {
  SnapshotEntry,
  SnapshotManifest,
  SnapshotRoots,
  SnapshotScope,
} from "./types";
import {
  SNAPSHOT_FORMAT,
  SNAPSHOT_SCHEMA_VERSION,
  SnapshotError,
} from "./types";

/* ------------------------------------------------------------------ */
/* Isolation and helpers                                                */
/* ------------------------------------------------------------------ */

const temporaryTrees: TestDirectory[] = [];

function makeTree(): TestDirectory {
  const tree = new TestDirectory();
  temporaryTrees.push(tree);
  return tree;
}

afterEach(() => {
  for (const tree of temporaryTrees.splice(0)) tree.cleanup();
});

const ROOTS: SnapshotRoots = {
  home: join("fake-root", "home"),
  localBackend: join("fake-root", "storage"),
};

const BUILD = {
  appVersion: "0.4.2",
  createdAt: "2026-10-25T00:00:00.000Z",
  platform: "win32-x64",
  hostname: "test-host",
} as const;

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function fileEntry(
  path: string,
  absolutePath: string,
  scope: SnapshotScope = "home",
): SnapshotEntry {
  const bytes = readFileSync(absolutePath);
  return { path, scope, bytes: bytes.length, sha256: sha256(bytes) };
}

function dirEntry(path: string, scope: SnapshotScope = "home"): SnapshotEntry {
  return { path, scope, bytes: 0, sha256: DIRECTORY_ENTRY_SHA256 };
}

function expectVerifyFailure(raw: string, contains: string): void {
  let thrown: unknown;
  try {
    parseManifest(raw);
  } catch (error) {
    thrown = error;
  }
  expect(
    thrown,
    `expected a rejection containing "${contains}"`,
  ).toBeInstanceOf(SnapshotError);
  expect((thrown as SnapshotError).code).toBe("verify_failed");
  expect((thrown as Error).message).toContain(contains);
}

/* ------------------------------------------------------------------ */
/* buildManifest                                                        */
/* ------------------------------------------------------------------ */

test("buildManifest: every field is filled and counts agree with entries", () => {
  // The directory-entry convention the whole package depends on.
  expect(DIRECTORY_ENTRY_SHA256).toBe(sha256(""));
  expect(DIRECTORY_ENTRY_SHA256).toBe(sha256(Buffer.alloc(0)));

  const tree = makeTree();
  const alpha = tree.createFile(join("home", "alpha.txt"), "alpha");
  const beta = tree.createFile(join("home", "beta.txt"), "beta!");
  const entries = [
    fileEntry("home/alpha.txt", alpha),
    fileEntry("home/beta.txt", beta),
    dirEntry("home/empty"),
  ];

  const manifest = buildManifest(entries, ROOTS, {
    ...BUILD,
    secrets: 3,
    warnings: ["followed symbolic link home/alpha.txt"],
  });

  expect(manifest.format).toBe(SNAPSHOT_FORMAT);
  expect(manifest.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
  expect(manifest.appVersion).toBe(BUILD.appVersion);
  expect(manifest.createdAt).toBe(BUILD.createdAt);
  expect(manifest.platform).toBe(BUILD.platform);
  expect(manifest.hostname).toBe(BUILD.hostname);
  expect(manifest.roots).toEqual(ROOTS);
  expect(manifest.entries).toEqual(entries);
  // `files` counts manifest entries, directory entries included (Lead ruling, M2).
  expect(manifest.counts).toEqual({ files: 3, bytes: 5 + 5, secrets: 3 });
  expect(manifest.warnings).toEqual(["followed symbolic link home/alpha.txt"]);
});

test("buildManifest: defaults are zero secrets, no warnings, and the full exclude table", () => {
  const manifest = buildManifest([], ROOTS, BUILD);
  expect(manifest.counts).toEqual({ files: 0, bytes: 0, secrets: 0 });
  expect(manifest.warnings).toEqual([]);
  expect(manifest.excluded).toHaveLength(22);
  // One-to-one with the exclude rows: same order, same path, same reason.
  expect(manifest.excluded).toEqual(
    SCOPE_RULES.filter((rule) => !rule.include).map((rule) => ({
      path: rule.pattern,
      reason: rule.reason,
    })),
  );
});

test("buildManifest: a project root is recorded only when one was exported", () => {
  const withProject = buildManifest(
    [],
    { ...ROOTS, project: "fake-root/repo" },
    BUILD,
  );
  expect(withProject.roots.project).toBe("fake-root/repo");
  const withoutProject = buildManifest([], ROOTS, BUILD);
  expect(withoutProject.roots.project).toBeUndefined();
  expect("project" in withoutProject.roots).toBe(false);
});

test("buildManifest: the caller's warnings and exclusions win when supplied", () => {
  const excluded = [{ path: "home/backups", reason: "nested package" }];
  const manifest = buildManifest([], ROOTS, {
    ...BUILD,
    excluded,
    warnings: ["case collision avoided"],
  });
  expect(manifest.excluded).toEqual(excluded);
  expect(manifest.warnings).toEqual(["case collision avoided"]);
});

/* ------------------------------------------------------------------ */
/* serialize / parse                                                    */
/* ------------------------------------------------------------------ */

test("serializeManifest: stable bytes, fixed key order, trailing newline", () => {
  const tree = makeTree();
  const alpha = tree.createFile(join("home", "alpha.txt"), "alpha");
  const manifest = buildManifest(
    [fileEntry("home/alpha.txt", alpha)],
    ROOTS,
    BUILD,
  );
  const first = serializeManifest(manifest);
  expect(serializeManifest(manifest)).toBe(first);
  expect(first.endsWith("\n")).toBe(true);

  const order = [
    "format",
    "schemaVersion",
    "appVersion",
    "createdAt",
    "platform",
    "hostname",
    "roots",
    "counts",
    "entries",
    "excluded",
    "warnings",
  ];
  let cursor = -1;
  for (const key of order) {
    const index = first.indexOf(`"${key}"`);
    expect(index, `${key} is present`).toBeGreaterThan(cursor);
    cursor = index;
  }
});

test("parseManifest: a serialized manifest round-trips", () => {
  const tree = makeTree();
  const alpha = tree.createFile(join("home", "alpha.txt"), "alpha");
  const manifest = buildManifest(
    [fileEntry("home/alpha.txt", alpha), dirEntry("home/empty")],
    { ...ROOTS, project: "fake-root/repo" },
    { ...BUILD, secrets: 2, warnings: ["note"] },
  );
  expect(parseManifest(serializeManifest(manifest))).toEqual(manifest);
});

test("parseManifest: structural damage is verify_failed, never a silent default", () => {
  const valid = serializeManifest(buildManifest([], ROOTS, BUILD));
  const mutate = (
    change: (record: Record<string, unknown>) => void,
  ): string => {
    const record = JSON.parse(valid) as Record<string, unknown>;
    change(record);
    return JSON.stringify(record);
  };

  expectVerifyFailure("{", "JSON");
  expectVerifyFailure("[]", "must be an object");
  expectVerifyFailure(
    mutate((record) => {
      record.format = "haruyuki-backup";
    }),
    "format must be",
  );
  expectVerifyFailure(
    mutate((record) => {
      record.schemaVersion = 0;
    }),
    "schemaVersion must be >= 1",
  );
  expectVerifyFailure(
    mutate((record) => {
      record.schemaVersion = 1.5;
    }),
    "non-negative integer",
  );
  expectVerifyFailure(
    mutate((record) => {
      record.counts = "nope";
    }),
    "counts must be an object",
  );
  expectVerifyFailure(
    mutate((record) => {
      record.warnings = [1];
    }),
    "warnings[0] must be a string",
  );
  expectVerifyFailure(
    mutate((record) => {
      record.excluded = [{ path: "home/logs" }];
    }),
    "excluded[0].reason must be a string",
  );

  const entry = {
    path: "home/alpha.txt",
    scope: "home",
    bytes: 1,
    sha256: sha256("a"),
  };
  const withEntry = (patch: Record<string, unknown>): string =>
    mutate((record) => {
      record.entries = [{ ...entry, ...patch }];
    });

  expectVerifyFailure(withEntry({ path: "../escape" }), "illegal segment");
  expectVerifyFailure(withEntry({ path: "home/./alpha" }), "illegal segment");
  expectVerifyFailure(withEntry({ path: "/absolute" }), "must be relative");
  expectVerifyFailure(withEntry({ path: "C:/absolute" }), "drive letter");
  expectVerifyFailure(
    withEntry({ path: "home/alpha/" }),
    "must not end with a slash",
  );
  expectVerifyFailure(
    withEntry({ path: "home\\alpha" }),
    "must use / separators",
  );
  expectVerifyFailure(withEntry({ scope: "elsewhere" }), "not a known scope");
  expectVerifyFailure(
    withEntry({ sha256: sha256("a").toUpperCase() }),
    "lowercase hex",
  );
  expectVerifyFailure(withEntry({ bytes: -1 }), "non-negative integer");
  expectVerifyFailure(
    mutate((record) => {
      record.entries = [entry, entry];
    }),
    "duplicate entry path",
  );
});

/* ------------------------------------------------------------------ */
/* checkVersion                                                         */
/* ------------------------------------------------------------------ */

test("checkVersion: equal is plain ok, newer is refused, older walks the chain", () => {
  const manifest = buildManifest([], ROOTS, BUILD);
  expect(checkVersion(manifest, SNAPSHOT_SCHEMA_VERSION)).toEqual({
    ok: true,
    migrations: [],
  });

  const newer = { ...manifest, schemaVersion: SNAPSHOT_SCHEMA_VERSION + 1 };
  expect(checkVersion(newer, SNAPSHOT_SCHEMA_VERSION)).toEqual({
    ok: false,
    migrations: [],
  });

  const older = { ...manifest, schemaVersion: 0 };
  expect(checkVersion(older, SNAPSHOT_SCHEMA_VERSION)).toEqual({
    ok: false,
    migrations: [],
  });

  // v1 is current, so the chain is empty; a version below it has no step to run.
  expect(MANIFEST_MIGRATIONS).toEqual([]);
});

test("checkVersion: appVersion never participates in compatibility", () => {
  const manifest = buildManifest([], ROOTS, { ...BUILD, appVersion: "99.0.0" });
  expect(checkVersion(manifest, SNAPSHOT_SCHEMA_VERSION).ok).toBe(true);
});

test("checkVersion: a gap in the migration chain is refused", () => {
  const manifest = buildManifest([], ROOTS, BUILD);
  // Pretend the package came from v2 while the program is at v4: with no step
  // registered for 2 -> 3 the chain cannot be walked, so it is refused.
  expect(
    checkVersion({ ...manifest, schemaVersion: 2 }, SNAPSHOT_SCHEMA_VERSION + 3)
      .ok,
  ).toBe(false);
});

/* ------------------------------------------------------------------ */
/* verifyManifest                                                       */
/* ------------------------------------------------------------------ */

function manifestWithFiles(): {
  tree: TestDirectory;
  alphaPath: string;
  betaPath: string;
  entries: SnapshotEntry[];
  manifest: SnapshotManifest;
} {
  const tree = makeTree();
  const alphaPath = tree.createFile(join("home", "alpha.txt"), "alpha");
  const betaPath = tree.createFile(join("home", "beta.txt"), "beta!");
  const entries = [
    fileEntry("home/alpha.txt", alphaPath),
    fileEntry("home/beta.txt", betaPath),
    dirEntry("home/empty"),
  ];
  return {
    tree,
    alphaPath,
    betaPath,
    entries,
    manifest: buildManifest(entries, ROOTS, BUILD),
  };
}

test("verifyManifest: a package that agrees with its manifest passes", () => {
  const { entries, manifest } = manifestWithFiles();
  expect(verifyManifest(manifest, entries)).toEqual({ ok: true, failures: 0 });
});

test("verifyManifest: one tampered byte reports the first failure and the total", () => {
  const { alphaPath, betaPath, entries, manifest } = manifestWithFiles();
  const tampered = readFileSync(alphaPath);
  // Same length, one byte different: only the digest can notice.
  tampered[0] = tampered[0] === 0x61 ? 0x62 : 0x61;
  writeFileSync(alphaPath, tampered);

  const actual = [
    fileEntry("home/alpha.txt", alphaPath),
    fileEntry("home/beta.txt", betaPath),
    dirEntry("home/empty"),
  ];
  const verification = verifyManifest(manifest, actual);
  expect(verification.ok).toBe(false);
  // bytes and counts.bytes are unchanged by an in-place edit, so exactly one
  // comparison disagrees.
  expect(verification.failures).toBe(1);
  const beforeSha = entries[0]?.sha256 ?? "";
  const afterSha = actual[0]?.sha256 ?? "";
  expect(beforeSha).not.toBe(afterSha);
  expect(verification.firstFailure).toEqual({
    path: "home/alpha.txt",
    kind: "sha256",
    expected: beforeSha,
    actual: afterSha,
  });
});

test("verifyManifest: a missing entry reports the entry first, then the counts", () => {
  const { entries, manifest } = manifestWithFiles();
  const actual = entries.filter((entry) => entry.path !== "home/beta.txt");
  const verification = verifyManifest(manifest, actual);
  expect(verification.ok).toBe(false);
  // The entry is missing, and both totals were computed from it.
  expect(verification.failures).toBe(3);
  expect(verification.firstFailure?.path).toBe("home/beta.txt");
  expect(verification.firstFailure?.kind).toBe("missing");
});

test("verifyManifest: an unexpected entry is reported after the manifest walk", () => {
  const { entries, manifest } = manifestWithFiles();
  const surprise: SnapshotEntry = {
    path: "home/surprise.txt",
    scope: "home",
    bytes: 2,
    sha256: sha256("zz"),
  };
  const verification = verifyManifest(manifest, [...entries, surprise]);
  expect(verification.ok).toBe(false);
  expect(verification.failures).toBe(3);
  expect(verification.firstFailure).toEqual({
    path: "home/surprise.txt",
    kind: "extra",
    expected: "not listed in the manifest",
    actual: "present in the package",
  });
});

test("verifyManifest: a size disagreement is reported as bytes", () => {
  const { entries, manifest } = manifestWithFiles();
  const actual = entries.map((entry) =>
    entry.path === "home/beta.txt"
      ? { ...entry, bytes: entry.bytes + 1 }
      : entry,
  );
  const verification = verifyManifest(manifest, actual);
  expect(verification.failures).toBe(2);
  expect(verification.firstFailure).toEqual({
    path: "home/beta.txt",
    kind: "bytes",
    expected: "5",
    actual: "6",
  });
});

test("verifyManifest: a wrong total is reported as counts", () => {
  const { entries, manifest } = manifestWithFiles();
  const lying: SnapshotManifest = {
    ...manifest,
    counts: { ...manifest.counts, files: manifest.counts.files + 1 },
  };
  const verification = verifyManifest(lying, entries);
  expect(verification.failures).toBe(1);
  expect(verification.firstFailure).toEqual({
    path: "counts.files",
    kind: "counts",
    expected: "4",
    actual: "3",
  });
});

test("verifyManifest: the first failure follows manifest order", () => {
  const { entries, manifest } = manifestWithFiles();
  const actual = entries.map((entry) =>
    entry.scope === "home" && entry.path.endsWith(".txt")
      ? { ...entry, sha256: sha256(`changed:${entry.path}`) }
      : entry,
  );
  const verification = verifyManifest(manifest, actual);
  expect(verification.failures).toBe(2);
  expect(verification.firstFailure?.path).toBe("home/alpha.txt");
  expect(verification.firstFailure?.kind).toBe("sha256");
});

/* ------------------------------------------------------------------ */
/* scope -> manifest -> verify, end to end inside M2                    */
/* ------------------------------------------------------------------ */

test("collectEntries feeds a manifest that verifies against a fresh pass", async () => {
  const tree = makeTree();
  const appHome = join(tree.path, "app-home");
  tree.createFile(join("app-home", "settings.json"), '{"permissions":{}}');
  tree.createFile(join("app-home", "sessions.jsonl"), "{}\n");
  tree.createDir(join("app-home", "usage"));
  tree.createFile(join("app-home", "usage", "ledger.jsonl"), "{}\n");
  tree.createDir(join("app-home", "logs"));
  tree.createFile(join("app-home", "logs", "debug.log"), "noise");

  const entries: SnapshotEntry[] = [];
  for await (const entry of collectEntries({
    appHome,
    storageDir: join(tree.path, "storage"),
    homedirRoot: join(tree.path, "home"),
  })) {
    entries.push(
      entry.kind === "dir"
        ? dirEntry(entry.path, entry.scope)
        : {
            path: entry.path,
            scope: entry.scope,
            bytes: entry.bytes,
            sha256: sha256(readFileSync(entry.absolutePath)),
          },
    );
  }
  const manifest = buildManifest(
    entries,
    {
      home: appHome,
      localBackend: join(tree.path, "storage"),
    },
    BUILD,
  );
  expect(manifest.counts.bytes).toBe(
    entries.reduce((total, entry) => total + entry.bytes, 0),
  );

  // Independent pass: a second walk plus a re-read of every file.
  const secondPass: SnapshotEntry[] = [];
  for await (const entry of collectEntries({
    appHome,
    storageDir: join(tree.path, "storage"),
    homedirRoot: join(tree.path, "home"),
  })) {
    secondPass.push(
      entry.kind === "dir"
        ? dirEntry(entry.path, entry.scope)
        : {
            path: entry.path,
            scope: entry.scope,
            bytes: entry.bytes,
            sha256: sha256(readFileSync(entry.absolutePath)),
          },
    );
  }
  expect(verifyManifest(manifest, secondPass)).toEqual({
    ok: true,
    failures: 0,
  });
  expect(manifest.entries.map((entry) => entry.path)).toContain(
    "home/settings.json",
  );
  expect(
    manifest.entries.some((entry) => entry.path.startsWith("home/logs")),
  ).toBe(false);
});
