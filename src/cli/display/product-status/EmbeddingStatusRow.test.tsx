/**
 * The embedding status row as it is actually painted (48-1 §7.4, 48-2 §3.4 D6).
 *
 * `embedding.test.ts` pins the copy; this file pins that AppView's mount
 * actually puts it on the screen and that the quiet default is quiet — a
 * disabled feature must paint no row at all, not an empty one. The reader is
 * the component's injectable seam, so the frame is driven without a settings
 * manager or a live build.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { EmbeddingStatusRow } from "@/cli/display/product-status/EmbeddingStatusRow";
import type { EmbeddingProductStatusSnapshot } from "@/cli/display/product-status/embedding";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";

afterEach(() => {
  resetInkTtyState();
});

function enabled(
  overrides: Partial<EmbeddingProductStatusSnapshot> = {},
): EmbeddingProductStatusSnapshot {
  return {
    enabled: true,
    backend: "builtin",
    model: "bge-small-zh-v1.5",
    ...overrides,
  };
}

describe("EmbeddingStatusRow", () => {
  test("paints the arm summary when enabled and there is a round", async () => {
    const tty = mountInkTty(
      <EmbeddingStatusRow
        width={80}
        readSnapshot={() =>
          enabled({
            arms: { lexical: 8, vector: 6, injected: 2, degraded: false },
            coverage: 0.92,
          })
        }
      />,
      { columns: 80, rows: 24 },
    );
    try {
      const rows = await tty.rows();
      expect(rows).toHaveLength(1);
      const line = rows[0] ?? "";
      expect(line).toContain("embedding");
      expect(line).toContain("2 in");
      expect(line).toContain("lex 8");
      expect(line).toContain("vec 6");
      expect(line).toContain("cov 92%");
    } finally {
      tty.stop();
    }
  });

  test("paints a running build with progress and ETA", async () => {
    const tty = mountInkTty(
      <EmbeddingStatusRow
        width={80}
        readSnapshot={() =>
          enabled({
            build: {
              state: "running",
              progress: 0.34,
              processedChunks: 1_200,
              totalChunks: 3_600,
              etaMs: 480_000,
            },
          })
        }
      />,
      { columns: 80, rows: 24 },
    );
    try {
      const line = (await tty.rows()).join("\n");
      expect(line).toContain("34%");
      expect(line).toContain("1.2k/3.6k");
      expect(line).toContain("ETA 8m");
    } finally {
      tty.stop();
    }
  });

  test("a degrade reason is visible, so a miss and a failure differ (S-04)", async () => {
    const tty = mountInkTty(
      <EmbeddingStatusRow
        width={80}
        readSnapshot={() => enabled({ degrade: "timedOut" })}
      />,
      { columns: 80, rows: 24 },
    );
    try {
      const line = (await tty.rows()).join("\n");
      expect(line).toContain("degraded");
      expect(line).toContain("timedOut");
    } finally {
      tty.stop();
    }
  });

  test("an off feature paints no row at all", async () => {
    const tty = mountInkTty(
      <EmbeddingStatusRow
        width={80}
        readSnapshot={() => ({ ...enabled(), enabled: false })}
      />,
      { columns: 80, rows: 24 },
    );
    try {
      expect(await tty.rows()).toEqual([]);
    } finally {
      tty.stop();
    }
  });

  test("an enabled feature with nothing to report paints no row (idle, §7.4)", async () => {
    const tty = mountInkTty(
      <EmbeddingStatusRow width={80} readSnapshot={() => enabled()} />,
      { columns: 80, rows: 24 },
    );
    try {
      expect(await tty.rows()).toEqual([]);
    } finally {
      tty.stop();
    }
  });

  test("narrow terminal degrades to the label instead of wrapping a field", async () => {
    const tty = mountInkTty(
      <EmbeddingStatusRow
        width={10}
        readSnapshot={() =>
          enabled({
            build: {
              state: "running",
              progress: 0.34,
              processedChunks: 1_200,
              totalChunks: 3_600,
              etaMs: 480_000,
            },
          })
        }
      />,
      { columns: 10, rows: 24 },
    );
    try {
      const rows = await tty.rows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toBe("embedding");
    } finally {
      tty.stop();
    }
  });
});
