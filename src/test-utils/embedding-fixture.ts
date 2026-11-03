/**
 * Reusable fixtures for the vector-embedding (feature 48) unit tests.
 *
 * Everything here is synthetic and created under the OS temp directory: no test
 * may point `HARUYUKI_HOME` / `LETTA_LOCAL_BACKEND_DIR` at the real harness data
 * (docs/31 §1.2 A2). The corpus is hand-written, deterministic and deliberately
 * small, so chunker and index expectations can be stated exactly.
 *
 * The vectors are fake but deterministic: an FNV-1a seed expanded with an LCG
 * and L2-normalized. Same text in, same vector out — across runs and processes —
 * which is what the cache/incremental tests need without a model runtime.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Default fake-embedding width; small so fixtures stay cheap to diff. */
export const EMBEDDING_FIXTURE_DIMENSIONS = 8;

export type EmbeddingFixtureDirs = {
  /** Isolated root, already created under the OS temp directory. */
  root: string;
  /** Redirect `HARUYUKI_HOME` here. */
  homeDir: string;
  /** Redirect `LETTA_LOCAL_BACKEND_DIR` here. */
  localBackendDir: string;
  /** Recursively removes {@link EmbeddingFixtureDirs.root}. */
  cleanup: () => void;
};

/**
 * Creates an isolated home + local-backend directory pair. Callers should point
 * the two environment variables at these paths before touching any harness code,
 * and call `cleanup()` in `afterEach`/`finally`.
 */
export function createEmbeddingFixtureDirs(
  prefix = "haru-embedding-fixture-",
): EmbeddingFixtureDirs {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const homeDir = join(root, "home");
  const localBackendDir = join(root, "local-backend");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(localBackendDir, { recursive: true });
  return {
    root,
    homeDir,
    localBackendDir,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Writes a fixture file below {@link EmbeddingFixtureDirs.root}. */
export function writeEmbeddingFixtureFile(
  dirs: EmbeddingFixtureDirs,
  relativePath: string,
  content: string,
): string {
  const absolutePath = join(dirs.root, ...relativePath.split("/"));
  mkdirSync(join(absolutePath, ".."), { recursive: true });
  writeFileSync(absolutePath, content, "utf8");
  return absolutePath;
}

/** Synthetic corpus, one entry per chunker edge case. */
export const EMBEDDING_FIXTURE_TEXTS = {
  chineseProse:
    "财务系统的记账方式是每日对账。对账结果写入当日的台账。月底再汇总一次。",
  mixedProse:
    "The deploy ran at 09:30. 回滚脚本仍然可用。Next step is the canary check. 之后再看监控。",
  /** One sentence with no terminator at all; exercises the hard-cut path. */
  longUnpunctuated:
    "这是一段没有任何标点符号的很长的中文文本用来测试切分器的硬切路径因此它必须足够长才能超过上限我们继续追加文字直到超过两百五十六个估计标记为止再多写一些内容确保长度足够然后看看块数到底是多少",
  /** Short table under the cap: must stay one atomic chunk. */
  table: [
    "| 项目 | 值 |",
    "| --- | --- |",
    "| 超时 | 30s |",
    "| 重试 | 2 |",
  ].join("\n"),
  /** Long table: must be split by rows with the header repeated per part. */
  longTable: [
    "| 键 | 说明 |",
    "| --- | --- |",
    ...Array.from(
      { length: 60 },
      (_unused, index) =>
        `| key_${index.toString().padStart(2, "0")} | 这是第 ${index} 行的说明文本，用于把表格撑到超过单块上限。 |`,
    ),
  ].join("\n"),
  /** Mostly fenced code with a prose lead-in; must be chunked, not skipped. */
  codeHeavy: [
    "下面这段脚本负责清理临时目录，执行前先确认路径。如果失败就保留现场并上报，不要自行删除任何东西。",
    "",
    "```bash",
    "set -euo pipefail",
    "for path in /tmp/hryk-*; do",
    '  echo "would remove $path"',
    "done",
    "```",
    "",
    "确认无误后再真正执行清理，并在日志里记录清理了哪些路径。",
  ].join("\n"),
  /** Pure fenced code: no prose, so the parent is lexical-only. */
  codeOnly: ["```ts", "export const answer = 42;", "```"].join("\n"),
  /** JSON-lines block: split by line, never by sentence. */
  jsonLines: [
    '{"level":"info","msg":"started","seq":1}',
    '{"level":"warn","msg":"retry","seq":2}',
    '{"level":"info","msg":"done","seq":3}',
  ].join("\n"),
  /** Log-lines block: split by line. */
  logLines: [
    "2026-01-01T00:00:01Z INFO boot",
    "2026-01-01T00:00:02Z WARN retry",
    "2026-01-01T00:00:03Z ERROR failed",
  ].join("\n"),
  /** Windows line endings; spans must still map back onto the original text. */
  crlf: "第一段使用 CRLF 换行。\r\n第二段也一样。\r\n",
  /** Full-width punctuation as sentence terminators. */
  fullwidth:
    "今天的进度还行！明天继续？；风险项已经登记。下一步是回归测试，然后发版。",
} as const;

function hashText(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * Deterministic fake embedding for a text. Not semantically meaningful, but
 * stable per text and L2-normalized, so cosine comparisons in tests are exact
 * enough for identity/equality assertions.
 */
export function fakeEmbeddingVector(
  text: string,
  dimensions: number = EMBEDDING_FIXTURE_DIMENSIONS,
): Float32Array {
  const width = Math.max(1, Math.floor(dimensions));
  const vector = new Float32Array(width);
  let state = hashText(text) || 0x9e3779b9;
  let sumOfSquares = 0;
  for (let index = 0; index < width; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const value = (state / 0xffffffff) * 2 - 1;
    vector[index] = value;
    sumOfSquares += value * value;
  }
  const norm = Math.sqrt(sumOfSquares);
  if (norm > 0) {
    for (let index = 0; index < width; index += 1) {
      vector[index] = (vector[index] ?? 0) / norm;
    }
  }
  return vector;
}

/** Batch form of {@link fakeEmbeddingVector}, one vector per text. */
export function fakeEmbeddingVectors(
  texts: readonly string[],
  dimensions: number = EMBEDDING_FIXTURE_DIMENSIONS,
): Float32Array[] {
  return texts.map((text) => fakeEmbeddingVector(text, dimensions));
}

/** Cosine similarity of two equal-length vectors; 0 for a zero vector. */
export function cosineSimilarity(
  left: ArrayLike<number>,
  right: ArrayLike<number>,
): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}
