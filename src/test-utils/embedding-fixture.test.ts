import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  cosineSimilarity,
  createEmbeddingFixtureDirs,
  EMBEDDING_FIXTURE_DIMENSIONS,
  EMBEDDING_FIXTURE_TEXTS,
  fakeEmbeddingVector,
  fakeEmbeddingVectors,
  writeEmbeddingFixtureFile,
} from "@/test-utils/embedding-fixture";

describe("embedding fixture directories", () => {
  test("creates isolated home and local-backend roots under the temp dir", () => {
    const dirs = createEmbeddingFixtureDirs();
    try {
      expect(existsSync(dirs.homeDir)).toBe(true);
      expect(existsSync(dirs.localBackendDir)).toBe(true);
      expect(dirs.homeDir.startsWith(dirs.root)).toBe(true);
      expect(dirs.localBackendDir.startsWith(dirs.root)).toBe(true);
      const file = writeEmbeddingFixtureFile(
        dirs,
        "nested/vectors.jsonl",
        "row\n",
      );
      expect(file.startsWith(dirs.root)).toBe(true);
      expect(existsSync(file)).toBe(true);
    } finally {
      dirs.cleanup();
    }
    expect(existsSync(dirs.root)).toBe(false);
  });
});

describe("fake embeddings", () => {
  test("are deterministic per text", () => {
    const first = fakeEmbeddingVector("财务系统每日对账");
    const second = fakeEmbeddingVector("财务系统每日对账");
    expect(Array.from(second)).toEqual(Array.from(first));
    expect(first).toHaveLength(EMBEDDING_FIXTURE_DIMENSIONS);
  });

  test("are L2-normalized and distinguishable across texts", () => {
    const first = fakeEmbeddingVector("财务系统");
    const second = fakeEmbeddingVector("代码剥离");
    const norm = Math.sqrt(
      Array.from(first).reduce((total, value) => total + value * value, 0),
    );
    expect(norm).toBeCloseTo(1, 6);
    expect(cosineSimilarity(first, first)).toBeCloseTo(1, 6);
    expect(Math.abs(cosineSimilarity(first, second))).toBeLessThan(0.999);
  });

  test("honour a custom width and normalize in batch", () => {
    const vectors = fakeEmbeddingVectors(["a", "b", "c"], 4);
    expect(vectors).toHaveLength(3);
    for (const vector of vectors) {
      expect(vector).toHaveLength(4);
    }
    expect(cosineSimilarity(vectors[0] ?? [], vectors[0] ?? [])).toBeCloseTo(
      1,
      6,
    );
  });

  test("the corpus covers the chunker edge cases", () => {
    for (const [name, text] of Object.entries(EMBEDDING_FIXTURE_TEXTS)) {
      expect(text.length, name).toBeGreaterThan(0);
    }
    expect(EMBEDDING_FIXTURE_TEXTS.codeHeavy).toContain("```");
    expect(EMBEDDING_FIXTURE_TEXTS.crlf).toContain("\r\n");
    expect(
      EMBEDDING_FIXTURE_TEXTS.longTable.split("\n").length,
    ).toBeGreaterThan(10);
  });
});
