import { describe, expect, test } from "bun:test";
import {
  runSubcommand,
  subcommandNeedsEarlyBackendMode,
} from "@/cli/subcommands/router";

describe("subcommand router", () => {
  test("routes version subcommand before TUI startup", async () => {
    const messages: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      messages.push(String(message));
    };

    try {
      const exitCode = await runSubcommand(["version"]);

      expect(exitCode).toBe(0);
      expect(messages).toHaveLength(1);
      // The fork carries a semver pre-release suffix (`0.35.0-better`), which is
      // valid semver; what matters here is the "<version> (<product>)" shape.
      expect(messages[0]).toMatch(
        /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)? .*\(Haruyuki\)$/,
      );
    } finally {
      console.log = originalLog;
    }
  });

  test("routes steps help with early backend selection", async () => {
    expect(subcommandNeedsEarlyBackendMode("steps")).toBe(true);
    expect(await runSubcommand(["steps", "--help"])).toBe(0);
  });

  test("routes recall help with early backend selection", async () => {
    // The subcommand reads the local store, so the backend mode has to be resolved
    // before it runs — the same reason `messages` and `memory` are listed.
    expect(subcommandNeedsEarlyBackendMode("recall")).toBe(true);
    expect(await runSubcommand(["recall", "--help"])).toBe(0);
  });

  test("routes connect subcommand", async () => {
    const exitCode = await runSubcommand(["connect", "help"]);
    expect(exitCode).toBe(0);
  });

  test("routes unified MCP help before TUI startup", async () => {
    const messages: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((
      chunk: string | Uint8Array,
      ...args: unknown[]
    ) => {
      messages.push(String(chunk));
      const callback = args.find((arg) => typeof arg === "function");
      if (typeof callback === "function") callback();
      return true;
    }) as typeof process.stdout.write;

    try {
      const exitCode = await runSubcommand(["mcp", "--help"]);

      expect(exitCode).toBe(0);
      expect(messages.join("\n")).toContain("haruyuki mcp tools");
      expect(messages.join("\n")).toContain("haruyuki mcp call");
    } finally {
      process.stdout.write = originalWrite;
    }
  });

  test("shows unified server help without starting a server", async () => {
    const messages: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      messages.push(String(message));
    };

    try {
      const exitCode = await runSubcommand(["server", "--help"]);

      expect(exitCode).toBe(0);
      expect(messages.join("\n")).toContain(
        "haruyuki server [App Server options]",
      );
      expect(messages.join("\n")).toContain("--listen [url]");
    } finally {
      console.log = originalLog;
    }
  });

  test("keeps app-server as a deprecated alias", async () => {
    const messages: string[] = [];
    const warnings: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (message?: unknown) => {
      messages.push(String(message));
    };
    console.error = (message?: unknown) => {
      warnings.push(String(message));
    };

    try {
      const exitCode = await runSubcommand(["app-server", "--help"]);

      expect(exitCode).toBe(0);
      expect(messages.join("\n")).toContain(
        "haruyuki server [App Server options]",
      );
      expect(warnings).toEqual([
        "Warning: `haruyuki app-server` is deprecated. Use `haruyuki server` instead.",
      ]);
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
  });

  test("routes mods help", async () => {
    const messages: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      messages.push(String(message));
    };

    try {
      const exitCode = await runSubcommand(["mods", "help"]);

      expect(exitCode).toBe(0);
      expect(messages.join("\n")).toContain("Usage:");
      expect(messages.join("\n")).toContain("haruyuki mods list");
    } finally {
      console.log = originalLog;
    }
  });

  test("does not register the removed dream subcommand", async () => {
    expect(await runSubcommand(["dream", "--help"])).toBeNull();
  });

  test("does not register the removed computer and teleport subcommands", async () => {
    expect(await runSubcommand(["computers", "--help"])).toBeNull();
    expect(await runSubcommand(["environments", "--help"])).toBeNull();
    expect(await runSubcommand(["envs", "--help"])).toBeNull();
    expect(await runSubcommand(["teleport", "--help"])).toBeNull();
  });

  test("does not register the removed account and relay subcommands", async () => {
    expect(await runSubcommand(["usage", "--help"])).toBeNull();
    expect(await runSubcommand(["permissions", "--help"])).toBeNull();
    expect(await runSubcommand(["shared-memory", "--help"])).toBeNull();
    expect(await runSubcommand(["feedback", "--help"])).toBeNull();
    expect(await runSubcommand(["remote", "--help"])).toBeNull();
  });

  test("does not register the removed sandbox subcommand", async () => {
    expect(await runSubcommand(["sandbox", "--help"])).toBeNull();
  });

  test("routes snapshot export and import help with early backend selection", async () => {
    const messages: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      messages.push(String(message));
    };

    try {
      // Both read this machine's data roots, so the backend mode has to be
      // resolved before they run — the same reason `memory` and `messages` are
      // listed.
      expect(subcommandNeedsEarlyBackendMode("export")).toBe(true);
      expect(subcommandNeedsEarlyBackendMode("import")).toBe(true);

      expect(await runSubcommand(["export", "--help"])).toBe(0);
      expect(await runSubcommand(["import", "--help"])).toBe(0);

      const output = messages.join("\n");
      expect(output).toContain("haruyuki export [--out <package>]");
      expect(output).toContain("haruyuki import --from <package>");
      // The §5.4.6 sensitive-data warning ships with the help text.
      expect(output).toContain("Do not commit a .hryk package to git");
    } finally {
      console.log = originalLog;
    }
  });

  test("identifies backend-aware subcommands for early backend selection", () => {
    expect(subcommandNeedsEarlyBackendMode("app-server")).toBe(true);
    expect(subcommandNeedsEarlyBackendMode("connect")).toBe(true);
    expect(subcommandNeedsEarlyBackendMode("dream")).toBe(false);
    expect(subcommandNeedsEarlyBackendMode("server")).toBe(true);
    expect(subcommandNeedsEarlyBackendMode("memory")).toBe(true);
    expect(subcommandNeedsEarlyBackendMode("mcp")).toBe(true);
    expect(subcommandNeedsEarlyBackendMode("model")).toBe(true);
    expect(subcommandNeedsEarlyBackendMode("models")).toBe(true);
    expect(subcommandNeedsEarlyBackendMode("mods")).toBe(true);
    expect(subcommandNeedsEarlyBackendMode("version")).toBe(false);
    expect(subcommandNeedsEarlyBackendMode(undefined)).toBe(false);
  });
});
