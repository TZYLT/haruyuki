/**
 * Boundary lifecycle tests (feature 48, package B5).
 *
 * Every test runs under a fresh `TestDirectory`; no test reads the real
 * harness home and deletion only happens inside the temp space. The index
 * directories are synthesised with B2's public writer, so the lifecycle is
 * exercised against the same pointer/generation contract production uses.
 */

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TestDirectory } from "@/test-utils/test-fs";
import {
  type EmbeddingIndexCoverage,
  type EmbeddingVectorUnit,
  embeddingCurrentPointerPath,
  embeddingGenerationDir,
  hashEmbeddingText,
  readEmbeddingIndex,
  readEmbeddingIndexPointer,
  writeEmbeddingIndex,
  writeEmbeddingIndexPointer,
} from "./embedding-format";
import {
  copyEmbeddingUnitIndex,
  deleteEmbeddingOrphanGenerations,
  markEmbeddingUnitDirty,
  needsEmbeddingIndexBuild,
  removeEmbeddingUnitIndex,
  summarizeEmbeddingCoverage,
  sweepEmbeddingOrphanGenerations,
} from "./embedding-lifecycle";

const temporaryTrees: TestDirectory[] = [];

afterEach(() => {
  for (const tree of temporaryTrees.splice(0)) tree.cleanup();
});

interface TestSpace {
  tree: TestDirectory;
  /** `<tmp>/recall-vectors/agent-1/space-1`, matching B2's layout. */
  spaceDir: string;
}

function makeSpace(): TestSpace {
  const tree = new TestDirectory();
  temporaryTrees.push(tree);
  return {
    tree,
    spaceDir: join(tree.path, "recall-vectors", "agent-1", "space-1"),
  };
}

function unitDirFor(spaceDir: string, unitKey: string): string {
  return join(spaceDir, ...unitKey.split("/"));
}

interface IndexOptions {
  generation?: string;
  text?: string;
  coverage?: { embeddedChars: number; recallableChars: number };
}

function addIndex(
  spaceDir: string,
  unitKey: string,
  options: IndexOptions = {},
): { generation: string; unitDir: string } {
  const text = options.text ?? "hello world";
  const embeddedChars = options.coverage?.embeddedChars ?? text.length;
  const recallableChars = options.coverage?.recallableChars ?? text.length;
  const coverage: EmbeddingIndexCoverage = {
    embeddedChars,
    recallableChars,
    ratio: recallableChars > 0 ? embeddedChars / recallableChars : 0,
  };
  const unit: EmbeddingVectorUnit = unitKey.startsWith("memory/")
    ? {
        agentId: "agent-1",
        spaceId: "space-1",
        memoryFileKey: unitKey.slice("memory/".length),
      }
    : { agentId: "agent-1", spaceId: "space-1", conversationKey: unitKey };
  const unitDir = unitDirFor(spaceDir, unitKey);
  const written = writeEmbeddingIndex({
    unitDir,
    unit,
    modelId: "bge-small-zh-v1.5",
    dimensions: 4,
    records: [
      {
        parentId: "parent-1",
        chunkIndex: 0,
        startChar: 0,
        endChar: text.length,
        spans: [{ startChar: 0, endChar: text.length }],
        focusChar: 0,
        textHash: hashEmbeddingText(text),
      },
    ],
    vectors: [[1, 0, 0, 0]],
    coverage,
    ...(options.generation === undefined
      ? {}
      : { generation: options.generation }),
  });
  return { generation: written.generation, unitDir };
}

/* ------------------------------------------------------------------ */
/* Deletion cascade                                                     */
/* ------------------------------------------------------------------ */

test("removeEmbeddingUnitIndex invalidates the pointer before deleting, and only its unit", () => {
  const { spaceDir } = makeSpace();
  const older = addIndex(spaceDir, "conv-a", { generation: "gen-a" });
  const newer = addIndex(spaceDir, "conv-a", { generation: "gen-b" });
  const sibling = addIndex(spaceDir, "conv-b", { generation: "gen-sibling" });

  let observed:
    | {
        pointerGone: boolean;
        generationsPresent: boolean;
        siblingPointerPresent: boolean;
      }
    | undefined;
  const result = removeEmbeddingUnitIndex(spaceDir, "conv-a", {
    onPointerInvalidated: (unitDir) => {
      observed = {
        pointerGone: !existsSync(embeddingCurrentPointerPath(unitDir)),
        generationsPresent:
          existsSync(embeddingGenerationDir(unitDir, older.generation)) &&
          existsSync(embeddingGenerationDir(unitDir, newer.generation)),
        siblingPointerPresent: existsSync(
          embeddingCurrentPointerPath(sibling.unitDir),
        ),
      };
    },
  });

  expect(observed).toEqual({
    pointerGone: true,
    generationsPresent: true,
    siblingPointerPresent: true,
  });
  if (!result.ok) throw new Error(result.detail ?? result.problem);
  expect(result.pointerInvalidated).toBe(true);
  expect([...result.removedGenerations].sort()).toEqual(["gen-a", "gen-b"]);
  expect(result.warnings).toEqual([]);
  expect(existsSync(older.unitDir)).toBe(false);
  expect(readEmbeddingIndexPointer(sibling.unitDir).ok).toBe(true);
  expect(
    existsSync(embeddingGenerationDir(sibling.unitDir, "gen-sibling")),
  ).toBe(true);

  // The pointer is gone, so a retry is an idempotent no-op.
  const retry = removeEmbeddingUnitIndex(spaceDir, "conv-a");
  if (!retry.ok) throw new Error(retry.detail ?? retry.problem);
  expect(retry.pointerInvalidated).toBe(false);
  expect(retry.removedGenerations).toEqual([]);
  expect(retry.warnings).toEqual([]);
});

test("removeEmbeddingUnitIndex tolerates a corrupt pointer, a half-deleted unit and unsafe keys", () => {
  const { spaceDir } = makeSpace();

  const corruptDir = unitDirFor(spaceDir, "conv-corrupt");
  mkdirSync(join(corruptDir, "gen-left"), { recursive: true });
  writeFileSync(embeddingCurrentPointerPath(corruptDir), "{not json");
  writeFileSync(join(corruptDir, "gen-left", "vectors.bin"), "x");

  const halfDir = unitDirFor(spaceDir, "conv-half");
  mkdirSync(join(halfDir, "gen-orphan"), { recursive: true });

  for (const unitKey of ["conv-corrupt", "conv-half"]) {
    const result = removeEmbeddingUnitIndex(spaceDir, unitKey);
    if (!result.ok) throw new Error(result.detail ?? result.problem);
    expect(result.warnings).toEqual([]);
    expect(existsSync(unitDirFor(spaceDir, unitKey))).toBe(false);
  }

  // Nothing exists: deleting is still success, so a cascade can be retried.
  const missing = removeEmbeddingUnitIndex(spaceDir, "conv-missing");
  if (!missing.ok) throw new Error(missing.detail ?? missing.problem);
  expect(missing.pointerInvalidated).toBe(false);
  expect(missing.removedGenerations).toEqual([]);

  for (const unsafe of [
    "",
    ".",
    "..",
    "a/../b",
    "memory",
    "other/x",
    "a/b/c",
    "conversation\\x",
  ]) {
    const result = removeEmbeddingUnitIndex(spaceDir, unsafe);
    expect(result.ok, unsafe).toBe(false);
    if (!result.ok) expect(result.problem).toBe("unsafe-unit-key");
  }
});

/* ------------------------------------------------------------------ */
/* Stale generations: preview / delete separation                       */
/* ------------------------------------------------------------------ */

test("sweepEmbeddingOrphanGenerations previews without deleting, then deletes exactly the preview", () => {
  const { spaceDir } = makeSpace();
  const conversation = addIndex(spaceDir, "conv-a", { generation: "gen-1" });
  addIndex(spaceDir, "conv-a", { generation: "gen-2" });
  addIndex(spaceDir, "conv-a", { generation: "gen-3" });
  addIndex(spaceDir, "conv-a", { generation: "gen-4" });
  const memory = addIndex(spaceDir, "memory/notes-abc", {
    generation: "gen-memory",
  });
  mkdirSync(join(conversation.unitDir, ".tmp-crashed"), { recursive: true });

  const preview = sweepEmbeddingOrphanGenerations(spaceDir);
  expect(preview.keepPerUnit).toBe(1);
  expect(preview.unitsScanned).toBe(2);
  expect(preview.generationsScanned).toBe(5);
  expect(preview.stale.map((entry) => entry.generation).sort()).toEqual([
    ".tmp-crashed",
    "gen-1",
    "gen-2",
  ]);
  for (const entry of preview.stale) {
    expect(existsSync(entry.path), `${entry.path} must survive a preview`).toBe(
      true,
    );
  }
  // Current + the one kept previous generation + the memory unit stay.
  expect(
    existsSync(embeddingGenerationDir(conversation.unitDir, "gen-4")),
  ).toBe(true);
  expect(
    existsSync(embeddingGenerationDir(conversation.unitDir, "gen-3")),
  ).toBe(true);
  expect(existsSync(embeddingGenerationDir(memory.unitDir, "gen-memory"))).toBe(
    true,
  );

  const deleted = deleteEmbeddingOrphanGenerations(spaceDir, preview);
  if (!deleted.ok) throw new Error(deleted.detail ?? deleted.problem);
  expect([...deleted.deleted].sort()).toEqual(
    [...preview.stale.map((entry) => entry.path)].sort(),
  );
  expect(deleted.skipped).toEqual([]);
  expect(deleted.warnings).toEqual([]);
  expect(
    existsSync(embeddingGenerationDir(conversation.unitDir, "gen-1")),
  ).toBe(false);
  expect(
    existsSync(embeddingGenerationDir(conversation.unitDir, "gen-2")),
  ).toBe(false);
  expect(existsSync(join(conversation.unitDir, ".tmp-crashed"))).toBe(false);
  expect(existsSync(embeddingCurrentPointerPath(conversation.unitDir))).toBe(
    true,
  );
  expect(readEmbeddingIndex(conversation.unitDir).ok).toBe(true);
  expect(sweepEmbeddingOrphanGenerations(spaceDir).stale).toEqual([]);

  // A preview from another space is refused rather than reinterpreted.
  const mismatch = deleteEmbeddingOrphanGenerations(
    join(spaceDir, "other-space"),
    preview,
  );
  expect(mismatch.ok).toBe(false);
  if (!mismatch.ok) expect(mismatch.problem).toBe("space-mismatch");
});

test("deleteEmbeddingOrphanGenerations skips a generation that became current after the preview", () => {
  const { spaceDir } = makeSpace();
  const older = addIndex(spaceDir, "conv-a", { generation: "gen-1" });
  addIndex(spaceDir, "conv-a", { generation: "gen-2" });

  const preview = sweepEmbeddingOrphanGenerations(spaceDir, { keep: 0 });
  expect(preview.stale.map((entry) => entry.generation)).toEqual(["gen-1"]);

  // A build between preview and delete promotes the previewed generation.
  const pointer = readEmbeddingIndexPointer(older.unitDir);
  if (!pointer.ok) throw new Error(pointer.detail ?? pointer.problem);
  writeEmbeddingIndexPointer(older.unitDir, {
    ...pointer.pointer,
    generation: "gen-1",
    updatedAt: new Date().toISOString(),
  });

  const deleted = deleteEmbeddingOrphanGenerations(spaceDir, preview);
  if (!deleted.ok) throw new Error(deleted.detail ?? deleted.problem);
  expect(deleted.deleted).toEqual([]);
  expect(deleted.skipped).toEqual([
    embeddingGenerationDir(older.unitDir, "gen-1"),
  ]);
  expect(existsSync(embeddingGenerationDir(older.unitDir, "gen-1"))).toBe(true);
});

test("a unit without a current pointer keeps its recent generations and reports orphans", () => {
  const { spaceDir } = makeSpace();
  const unitDir = unitDirFor(spaceDir, "conv-orphan");
  for (const generation of ["gen-1", "gen-2", "gen-3"]) {
    mkdirSync(join(unitDir, generation), { recursive: true });
  }
  const preview = sweepEmbeddingOrphanGenerations(spaceDir, { keep: 2 });
  expect(preview.stale.map((entry) => entry.generation)).toEqual(["gen-1"]);
  const entry = preview.stale[0];
  expect(entry?.reason).toBe("orphan-generation");
});

/* ------------------------------------------------------------------ */
/* Fork: lazy rebuild decision and independence                         */
/* ------------------------------------------------------------------ */

test("fork needs a build, the dirty marker self-clears after a rebuild, and the source is untouched", () => {
  const { spaceDir } = makeSpace();
  const source = addIndex(spaceDir, "conv-source", {
    generation: "gen-source",
  });

  expect(needsEmbeddingIndexBuild(spaceDir, "conv-source")).toBe(false);
  expect(needsEmbeddingIndexBuild(spaceDir, "conv-fork")).toBe(true);

  const marked = markEmbeddingUnitDirty(spaceDir, "conv-fork", {
    reason: "fork",
  });
  if (!marked.ok) throw new Error(marked.detail ?? marked.problem);
  expect(existsSync(marked.markerPath)).toBe(true);
  expect(needsEmbeddingIndexBuild(spaceDir, "conv-fork")).toBe(true);

  // Marking a fork schedules nothing and copies nothing from the source.
  expect(readEmbeddingIndexPointer(source.unitDir).ok).toBe(true);
  expect(existsSync(embeddingGenerationDir(source.unitDir, "gen-source"))).toBe(
    true,
  );
  expect(
    existsSync(embeddingCurrentPointerPath(unitDirFor(spaceDir, "conv-fork"))),
  ).toBe(false);

  addIndex(spaceDir, "conv-fork", { generation: "gen-fork" });
  expect(needsEmbeddingIndexBuild(spaceDir, "conv-fork")).toBe(false);
  const sourcePointer = readEmbeddingIndexPointer(source.unitDir);
  if (!sourcePointer.ok)
    throw new Error(sourcePointer.detail ?? sourcePointer.problem);
  expect(sourcePointer.pointer.generation).toBe("gen-source");

  // A marker newer than the pointer (an explicit re-dirty) flips it back.
  markEmbeddingUnitDirty(spaceDir, "conv-fork", {
    clock: () => Date.now() + 60_000,
  });
  expect(needsEmbeddingIndexBuild(spaceDir, "conv-fork")).toBe(true);

  const unsafe = markEmbeddingUnitDirty(spaceDir, "../escape");
  expect(unsafe.ok).toBe(false);
  if (!unsafe.ok) expect(unsafe.problem).toBe("unsafe-unit-key");
});

test("copyEmbeddingUnitIndex creates its own generation and never hard-links the source", () => {
  const { spaceDir } = makeSpace();
  const source = addIndex(spaceDir, "conv-source", {
    generation: "gen-source",
  });

  const copied = copyEmbeddingUnitIndex(
    { spaceDir, unitKey: "conv-source" },
    { spaceDir, unitKey: "conv-fork" },
  );
  if (!copied.ok) throw new Error(copied.detail ?? copied.problem);
  expect(copied.sourceGeneration).toBe("gen-source");
  expect(copied.targetGeneration).not.toBe("gen-source");
  expect(copied.records).toBe(1);

  const target = readEmbeddingIndex(copied.targetUnitDir);
  if (!target.ok) throw new Error(target.detail ?? target.problem);
  const origin = readEmbeddingIndex(source.unitDir);
  if (!origin.ok) throw new Error(origin.detail ?? origin.problem);
  expect(Array.from(target.snapshot.vectors)).toEqual(
    Array.from(origin.snapshot.vectors),
  );

  // Overwriting the copy's bytes must not reach the source: a hard link would.
  const sourceVectors = join(
    embeddingGenerationDir(source.unitDir, "gen-source"),
    "vectors.bin",
  );
  const targetVectors = join(
    copied.targetUnitDir,
    copied.targetGeneration,
    "vectors.bin",
  );
  const originalSourceBytes = readFileSync(sourceVectors);
  writeFileSync(targetVectors, Buffer.from("replaced"));
  expect(readFileSync(sourceVectors).equals(originalSourceBytes)).toBe(true);
  expect(readEmbeddingIndex(source.unitDir).ok).toBe(true);
  expect(embeddingGenerationDir(source.unitDir, "gen-source")).not.toBe(
    embeddingGenerationDir(copied.targetUnitDir, copied.targetGeneration),
  );

  const sameUnit = copyEmbeddingUnitIndex(
    { spaceDir, unitKey: "conv-source" },
    { spaceDir, unitKey: "conv-source" },
  );
  expect(sameUnit.ok).toBe(false);
  if (!sameUnit.ok) expect(sameUnit.problem).toBe("unsafe-unit-key");

  const unknown = copyEmbeddingUnitIndex(
    { spaceDir, unitKey: "conv-missing" },
    { spaceDir, unitKey: "conv-fork-2" },
  );
  expect(unknown.ok).toBe(false);
  if (!unknown.ok) expect(unknown.problem).toBe("source-index-unavailable");
});

/* ------------------------------------------------------------------ */
/* Coverage summary                                                     */
/* ------------------------------------------------------------------ */

test("summarizeEmbeddingCoverage rolls B2 metadata and A2 state into the status numbers", () => {
  const { spaceDir } = makeSpace();
  addIndex(spaceDir, "conv-a", {
    generation: "gen-a",
    coverage: { embeddedChars: 10, recallableChars: 20 },
  });
  addIndex(spaceDir, "conv-b", {
    generation: "gen-b",
    coverage: { embeddedChars: 30, recallableChars: 60 },
  });
  mkdirSync(unitDirFor(spaceDir, "conv-broken"), { recursive: true });
  addIndex(spaceDir, "conv-stale", {
    generation: "gen-1",
    coverage: { embeddedChars: 0, recallableChars: 0 },
  });
  addIndex(spaceDir, "conv-stale", {
    generation: "gen-2",
    coverage: { embeddedChars: 0, recallableChars: 0 },
  });
  addIndex(spaceDir, "conv-stale", {
    generation: "gen-3",
    coverage: { embeddedChars: 0, recallableChars: 0 },
  });

  const withoutState = summarizeEmbeddingCoverage(spaceDir);
  expect(withoutState.units).toBe(4);
  expect(withoutState.indexedUnits).toBe(3);
  expect(withoutState.coverage).toBeCloseTo(0.5);
  expect(withoutState.missingUnits).toBe(1);
  expect(withoutState.missingUnitKeys).toEqual(["conv-broken"]);
  expect(withoutState.staleGenerations).toBe(1);

  const withState = summarizeEmbeddingCoverage(spaceDir, {
    coverage: { embeddedChars: 80, recallableChars: 100 },
    failures: [{ conversationId: "conv-a" }, { conversationId: "conv-failed" }],
  });
  expect(withState.coverage).toBeCloseTo(0.8);
  expect(withState.missingUnits).toBe(2);
  expect(withState.missingUnitKeys).toEqual(["conv-broken", "conv-failed"]);

  // A2's snapshot projection already carries a ratio; it wins over the counts.
  const snapshot = summarizeEmbeddingCoverage(spaceDir, {
    coverage: { embeddedChars: 0, recallableChars: 0, ratio: 0.42 },
  });
  expect(snapshot.coverage).toBeCloseTo(0.42);
});
