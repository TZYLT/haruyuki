import { describe, expect, test } from "bun:test";
import {
  detectEmbeddingWorkerRuntime,
  EMBEDDING_WORKER_BUNDLE_FILENAME,
  EMBEDDING_WORKER_SOURCE_FILENAME,
  type EmbeddingWorkerEntryCandidates,
  EmbeddingWorkerEntryMissingError,
  resolveEmbeddingWorkerEntry,
} from "./worker-entry-path";

const candidates: EmbeddingWorkerEntryCandidates = {
  bundled: "/pkg/embedding-worker.js",
  source: "/repo/src/backend/local/embedding/worker-entry.ts",
};

function existsIn(paths: readonly string[]): (path: string) => boolean {
  return (path) => paths.includes(path);
}

describe("embedding worker entry contract", () => {
  test("file-name constants match build.js and package.json files", () => {
    expect(EMBEDDING_WORKER_BUNDLE_FILENAME).toBe("embedding-worker.js");
    expect(EMBEDDING_WORKER_SOURCE_FILENAME).toBe("worker-entry.ts");
  });

  test("detects the Bun runtime this test suite runs on", () => {
    expect(detectEmbeddingWorkerRuntime()).toBe("bun");
  });

  test("Bun prefers the source entry even when a stale bundle exists", () => {
    const resolved = resolveEmbeddingWorkerEntry(candidates, {
      runtime: "bun",
      exists: () => true,
    });
    expect(resolved.kind).toBe("source");
    expect(resolved.path).toBe(candidates.source);
    expect(resolved.runtime).toBe("bun");
  });

  test("Node prefers the bundled worker shipped in the package", () => {
    const resolved = resolveEmbeddingWorkerEntry(candidates, {
      runtime: "node",
      exists: () => true,
    });
    expect(resolved.kind).toBe("bundled");
    expect(resolved.path).toBe(candidates.bundled);
  });

  test("falls back to the other candidate when the preferred one is absent", () => {
    const bunOnlyBundle = resolveEmbeddingWorkerEntry(candidates, {
      runtime: "bun",
      exists: existsIn([candidates.bundled]),
    });
    expect(bunOnlyBundle.kind).toBe("bundled");
    const nodeOnlySource = resolveEmbeddingWorkerEntry(candidates, {
      runtime: "node",
      exists: existsIn([candidates.source]),
    });
    expect(nodeOnlySource.kind).toBe("source");
  });

  test("prefer overrides the runtime default", () => {
    const resolved = resolveEmbeddingWorkerEntry(candidates, {
      runtime: "bun",
      prefer: "bundled",
      exists: () => true,
    });
    expect(resolved.kind).toBe("bundled");
  });

  test("throws a typed error when neither entry exists", () => {
    let failure: EmbeddingWorkerEntryMissingError | null = null;
    try {
      resolveEmbeddingWorkerEntry(candidates, {
        runtime: "node",
        exists: () => false,
      });
    } catch (error) {
      failure = error as EmbeddingWorkerEntryMissingError;
    }
    expect(failure).toBeInstanceOf(EmbeddingWorkerEntryMissingError);
    expect(failure?.runtime).toBe("node");
    expect(failure?.candidates).toEqual(candidates);
    expect(failure?.message).toContain(candidates.bundled);
    expect(failure?.message).toContain(candidates.source);
  });
});
