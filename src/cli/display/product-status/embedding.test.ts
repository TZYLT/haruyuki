/**
 * The embedding half of the product-status line (48-1 §7.4, 48-2 §3.4 D6).
 *
 * The renderer is the seam between the poller and the panel, so this file pins
 * the two things a merged frame cannot see: the exact wording of each state
 * (running / failed / degraded / arms) and the narrow-width degradation order.
 * It also pins the rule that gives the feature its quiet default — disabled, or
 * enabled with nothing to report, renders **no row at all**.
 */
import { describe, expect, test } from "bun:test";
import chalk from "chalk";
import stripAnsi from "strip-ansi";
import {
  EMBEDDING_SEGMENT_SEPARATOR,
  type EmbeddingProductStatusSnapshot,
  embeddingModelLabel,
  formatEmbeddingCount,
  formatEmbeddingEta,
  renderEmbeddingSegment,
} from "./embedding";

function snapshot(
  overrides: Partial<EmbeddingProductStatusSnapshot> = {},
): EmbeddingProductStatusSnapshot {
  return {
    enabled: true,
    backend: "builtin",
    model: "bge-small-zh-v1.5",
    ...overrides,
  };
}

/** The renderer hands back styled text; assertions read the visible bytes. */
function visible(
  snap: EmbeddingProductStatusSnapshot | null,
  width = 80,
): string {
  return stripAnsi(renderEmbeddingSegment(snap, width, chalk));
}

describe("formatEmbeddingCount", () => {
  test("keeps small counts exact and compresses thousands and millions", () => {
    expect(formatEmbeddingCount(0)).toBe("0");
    expect(formatEmbeddingCount(950)).toBe("950");
    expect(formatEmbeddingCount(1_200)).toBe("1.2k");
    expect(formatEmbeddingCount(12_400)).toBe("12k");
    expect(formatEmbeddingCount(3_600_000)).toBe("4M");
  });

  test("an absent or malformed count renders as zero, never NaN", () => {
    expect(formatEmbeddingCount(null)).toBe("0");
    expect(formatEmbeddingCount(undefined)).toBe("0");
    expect(formatEmbeddingCount(Number.NaN)).toBe("0");
    expect(formatEmbeddingCount(-5)).toBe("0");
  });
});

describe("formatEmbeddingEta", () => {
  test("seconds under a minute, minutes above it", () => {
    expect(formatEmbeddingEta(1_000)).toBe("ETA 1s");
    expect(formatEmbeddingEta(32_000)).toBe("ETA 32s");
    expect(formatEmbeddingEta(480_000)).toBe("ETA 8m");
  });

  test("a missing estimate is dropped rather than printed as NaN", () => {
    expect(formatEmbeddingEta(null)).toBeNull();
    expect(formatEmbeddingEta(undefined)).toBeNull();
    expect(formatEmbeddingEta(Number.NaN)).toBeNull();
  });
});

describe("renderEmbeddingSegment", () => {
  test("renders nothing while the feature is off", () => {
    expect(visible(snapshot({ enabled: false }))).toBe("");
    expect(visible(null)).toBe("");
  });

  test("enabled but idle and empty renders no row (48-1 §7.4)", () => {
    expect(visible(snapshot())).toBe("");
    // A zero-width frame is never painted either.
    expect(visible(snapshot(), 0)).toBe("");
  });

  test("a running build paints progress, chunk counts, model and ETA", () => {
    const line = visible(
      snapshot({
        build: {
          state: "running",
          progress: 0.34,
          processedChunks: 1_200,
          totalChunks: 3_600,
          etaMs: 480_000,
        },
      }),
    );
    expect(line).toContain("embedding");
    expect(line).toContain("34%");
    expect(line).toContain("bge-small-zh-v1.5");
    expect(line).toContain("1.2k/3.6k");
    expect(line).toContain("ETA 8m");
    // Display order: label, progress, model, chunks, ETA.
    expect(line.indexOf("34%")).toBeLessThan(line.indexOf("bge-small"));
    expect(line.indexOf("bge-small")).toBeLessThan(line.indexOf("1.2k/3.6k"));
    expect(line.indexOf("1.2k/3.6k")).toBeLessThan(line.indexOf("ETA"));
    // Builtin spends no column on the backend; the model id already says it.
    expect(line).not.toContain("endpoint");
  });

  test("an endpoint backend is named in the segment (egress visibility)", () => {
    const line = visible(
      snapshot({
        backend: "endpoint",
        model: "text-embedding-3-small",
        arms: { lexical: 4, vector: 2, injected: 1, degraded: false },
      }),
    );
    expect(line).toContain("endpoint");
    expect(line).toContain("text-embedding-3-small");
  });

  test("narrow widths drop the tail of the fields, never truncate a field", () => {
    const wide = snapshot({
      build: {
        state: "running",
        progress: 0.34,
        processedChunks: 1_200,
        totalChunks: 3_600,
        etaMs: 480_000,
      },
    });
    const fields = ["34%", "bge-small-zh-v1.5", "1.2k/3.6k", "ETA 8m"];
    const widths = [80, 24, 14, 10];
    let previousLength = Number.POSITIVE_INFINITY;
    for (const width of widths) {
      const line = visible(wide, width);
      expect(line.startsWith("embedding")).toBe(true);
      expect(line.length).toBeLessThanOrEqual(previousLength);
      previousLength = line.length;
      // Whatever survives is whole words separated by the shared separator.
      for (const field of fields) {
        if (line.includes(field)) {
          expect(line.split(EMBEDDING_SEGMENT_SEPARATOR)).toContain(field);
        }
      }
    }
    // Too narrow for even the label gives way entirely.
    expect(visible(wide, 3)).toBe("");
  });

  test("a failed build shows the redacted reason instead of progress", () => {
    const line = visible(
      snapshot({
        build: {
          state: "failed",
          progress: 0.5,
          error: "encoder exited during batch 2",
        },
      }),
    );
    expect(line).toContain("embedding");
    expect(line).toContain("failed");
    expect(line).toContain("encoder exited during batch 2");
    expect(line).not.toContain("50%");
  });

  test("a degraded last turn is distinguishable from a miss (S-04)", () => {
    expect(visible(snapshot({ degrade: "timedOut" }))).toContain(
      "embedding degraded · timedOut",
    );
    expect(visible(snapshot({ degrade: "unavailable" }))).toContain(
      "unavailable",
    );
    expect(
      visible(
        snapshot({
          arms: { lexical: 8, vector: 0, injected: 0, degraded: true },
        }),
      ),
    ).toContain("embedding degraded");
  });

  test("a healthy round paints the two-arm summary and coverage", () => {
    const line = visible(
      snapshot({
        arms: { lexical: 8, vector: 6, injected: 2, degraded: false },
        coverage: 0.924,
      }),
    );
    expect(line).toContain("embedding");
    expect(line).toContain("2 in");
    expect(line).toContain("lex 8");
    expect(line).toContain("vec 6");
    expect(line).toContain("cov 92%");
    // The injection count is the field that survives the longest.
    expect(line.indexOf("2 in")).toBeLessThan(line.indexOf("lex 8"));
    expect(line.indexOf("lex 8")).toBeLessThan(line.indexOf("vec 6"));
  });

  test("a completed build with coverage reads as built, not as running", () => {
    const line = visible(
      snapshot({ build: { state: "completed", progress: 1 }, coverage: 0.8 }),
    );
    expect(line).toContain("built");
    expect(line).toContain("80% coverage");
  });

  test("a cancelled or idle build with no other data stays quiet", () => {
    expect(
      visible(snapshot({ build: { state: "cancelled", progress: 0 } })),
    ).toBe("");
    expect(
      visible(snapshot({ build: { state: "idle", progress: null } })),
    ).toBe("");
  });

  test("a bad model id cannot break the line", () => {
    const line = visible(snapshot({ model: null }));
    expect(line).toBe("");
    expect(visible(snapshot({ model: null }), 80)).toBe("");
  });
});

describe("embeddingModelLabel", () => {
  test("prefers the model id and falls back to the backend kind", () => {
    expect(embeddingModelLabel(snapshot())).toBe("bge-small-zh-v1.5");
    expect(embeddingModelLabel(snapshot({ model: null }))).toBe("builtin");
    expect(
      embeddingModelLabel(snapshot({ model: null, backend: "endpoint" })),
    ).toBe("endpoint");
  });
});
