import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseChdirCommand,
  resolveChdirTarget,
} from "@/cli/helpers/chdir-command";

describe("/cd command", () => {
  test("is the only working-directory name the registry keeps", () => {
    const registryPath = fileURLToPath(
      new URL("../cli/commands/registry.ts", import.meta.url),
    );
    const source = readFileSync(registryPath, "utf-8");

    expect(source).not.toContain('"/chdir"');
    expect(source).toContain('"/cd"');
    expect(source).toContain("Change working directory for this TUI session");
  });

  test("useSubmitHandler switches local cwd and queues cwd-changed reminder", () => {
    const submitHandlerPath = fileURLToPath(
      new URL("../cli/app/use-submit-handler.ts", import.meta.url),
    );
    const source = readFileSync(submitHandlerPath, "utf-8");

    expect(source).toContain("parseChdirCommand(trimmed)");
    expect(source).toContain("await switchCurrentRuntimeWorkingDirectory");
    expect(source).toContain("pendingSessionContextReason");
    expect(source).toContain('"cwd_changed"');
  });

  test("parses the surviving command and refuses the retired spelling", () => {
    // `/chdir` is retired at the routing boundary (hubs.ts REMOVED_COMMANDS), and
    // the parser no longer knows it either: two layers agreeing is what keeps the
    // old name from working by accident.
    expect(parseChdirCommand("/chdir ../foo")).toBeNull();
    expect(parseChdirCommand('/cd "dir with spaces"')).toEqual({
      command: "/cd",
      pathArg: "dir with spaces",
    });
    expect(parseChdirCommand("/cd")).toEqual({
      command: "/cd",
      pathArg: null,
    });
    expect(parseChdirCommand("/cdx foo")).toBeNull();
  });

  test("resolves relative targets and rejects files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "letta-chdir-command-"));
    try {
      const nested = path.join(root, "nested");
      await mkdir(nested);
      const file = path.join(root, "file.txt");
      await writeFile(file, "not a directory\n");

      await expect(resolveChdirTarget("nested", root)).resolves.toBe(
        await realpath(nested),
      );
      await expect(resolveChdirTarget("file.txt", root)).rejects.toThrow(
        "Not a directory",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
