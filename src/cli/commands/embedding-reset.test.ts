import { describe, expect, test } from "bun:test";
import { parseEmbeddingCommand } from "@/cli/commands/embedding-command-parser";

/**
 * `reset` (48-1 §6.10) is the only destructive embedding verb, so its grammar
 * lives in its own file: bare = preview, `--confirm` = delete, and the target is
 * exactly one of current / `--all` / `--model <id>`.
 */
describe("embedding reset grammar", () => {
  test("previews unless --confirm, and takes --all or --model", () => {
    expect(parseEmbeddingCommand(["reset"])).toEqual({
      kind: "reset",
      scope: "current",
      confirmed: false,
    });
    expect(parseEmbeddingCommand(["reset", "--confirm"])).toEqual({
      kind: "reset",
      scope: "current",
      confirmed: true,
    });
    expect(parseEmbeddingCommand(["reset", "--all", "--confirm"])).toEqual({
      kind: "reset",
      scope: "all",
      confirmed: true,
    });
    expect(
      parseEmbeddingCommand(["reset", "--model", "bge-m3", "--confirm"]),
    ).toEqual({
      kind: "reset",
      scope: "model",
      model: "bge-m3",
      confirmed: true,
    });
    expect(
      parseEmbeddingCommand(["reset", "--all", "--model", "bge-m3"]).kind,
    ).toBe("error");
    expect(parseEmbeddingCommand(["reset", "--model"]).kind).toBe("error");
    expect(parseEmbeddingCommand(["reset", "now"]).kind).toBe("error");
  });
});
