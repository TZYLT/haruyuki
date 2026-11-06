import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearEmbeddingCrossProcessCancel,
  embeddingCancelFilePath,
  readEmbeddingCrossProcessCancel,
  requestEmbeddingCrossProcessCancel,
} from "@/backend/local/embedding-cancel";

let dir: string | null = null;

function tempDir(): string {
  dir = mkdtempSync(join(tmpdir(), "haru-embedding-cancel-"));
  return dir;
}

afterEach(() => {
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("cross-process embedding cancel", () => {
  test("writes, reads and clears the sentinel", () => {
    const space = tempDir();
    expect(readEmbeddingCrossProcessCancel(space)).toBeNull();
    expect(
      requestEmbeddingCrossProcessCancel(space, { buildId: "build-7" }),
    ).toBe(true);
    expect(existsSync(embeddingCancelFilePath(space))).toBe(true);
    expect(readEmbeddingCrossProcessCancel(space)?.buildId).toBe("build-7");
    clearEmbeddingCrossProcessCancel(space);
    expect(readEmbeddingCrossProcessCancel(space)).toBeNull();
  });

  test("an unreadable or malformed sentinel is treated as absent", () => {
    const space = tempDir();
    writeFileSync(embeddingCancelFilePath(space), "{not json");
    expect(readEmbeddingCrossProcessCancel(space)).toBeNull();
    writeFileSync(embeddingCancelFilePath(space), JSON.stringify([1, 2]));
    expect(readEmbeddingCrossProcessCancel(space)).toBeNull();
  });
});
