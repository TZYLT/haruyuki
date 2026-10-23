import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  CONSOLE_FONT_HELPER_SCRIPT,
  consoleFontHelperArgs,
  consoleFontHelperExecutable,
  openConsoleFontHelperPort,
  parseConsoleFontHelperReply,
} from "@/cli/helpers/console-font-node";

/** A spawned-helper stand-in: pipes both ways, no PowerShell. */
class FakeHelper extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  requests: string[] = [];
  respond: (request: Record<string, unknown>) => string | null = () => null;

  constructor() {
    super();
    let buffered = "";
    this.stdin.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      for (;;) {
        const index = buffered.indexOf("\n");
        if (index === -1) return;
        const line = buffered.slice(0, index);
        buffered = buffered.slice(index + 1);
        if (line.trim() === "") continue;
        this.requests.push(line);
        const request = JSON.parse(line) as Record<string, unknown>;
        const reply = this.respond(request);
        if (reply !== null) this.stdout.write(`${reply}\r\n`);
      }
    });
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  unref(): void {}
}

interface FakeSpawnOptions {
  /** Omit the ready line to exercise the startup timeout. */
  ready?: boolean;
  faces?: string[];
  requestTimeoutMs?: number;
}

function createFakeSpawn(options: FakeSpawnOptions = {}): {
  spawnImpl: typeof import("node:child_process").spawn;
  helper: FakeHelper;
  spawned: () => number;
  spawnOptions: () => { file: string; args: string[]; options: any } | null;
} {
  const helper = new FakeHelper();
  let spawned = 0;
  let captured: { file: string; args: string[]; options: any } | null = null;
  const spawnImpl = ((file: string, args: string[], spawnOptions: any) => {
    spawned += 1;
    captured = { file, args, options: spawnOptions };
    queueMicrotask(() => {
      if (options.ready === false) return;
      helper.stdout.write(
        `${JSON.stringify({
          ok: true,
          op: "ready",
          faces: options.faces ?? ["Consolas", "NSimSun"],
        })}\r\n`,
      );
    });
    return helper;
  }) as unknown as typeof import("node:child_process").spawn;
  return {
    spawnImpl,
    helper,
    spawned: () => spawned,
    spawnOptions: () => captured,
  };
}

/** The reply the fake gives to one request; the helper answers per op. */
function replyFor(request: Record<string, unknown>): string | null {
  if (request.op === "read") {
    return JSON.stringify({
      ok: true,
      face: "Consolas",
      cellWidth: 9,
      cellHeight: 18,
      family: 54,
      weight: 400,
    });
  }
  if (request.op === "apply") {
    return JSON.stringify({ ok: true });
  }
  return null;
}

describe("parseConsoleFontHelperReply", () => {
  test("reads a ready line and its font inventory", () => {
    expect(
      parseConsoleFontHelperReply(
        '{"ok":true,"op":"ready","faces":["Consolas","NSimSun","霞鹜文楷等宽"]}\r',
      ),
    ).toEqual({
      ok: true,
      op: "ready",
      faces: ["Consolas", "NSimSun", "霞鹜文楷等宽"],
    });
  });

  test("reads a font reading", () => {
    expect(
      parseConsoleFontHelperReply(
        '{"ok":true,"face":"宋体","cellWidth":10,"cellHeight":18,"family":7,"weight":400}',
      ),
    ).toEqual({
      ok: true,
      face: "宋体",
      cellWidth: 10,
      cellHeight: 18,
      family: 7,
      weight: 400,
    });
  });

  test("keeps a failure's error code, and its Win32 code when there is one", () => {
    expect(
      parseConsoleFontHelperReply('{"ok":false,"error":"open","win32":6}'),
    ).toEqual({ ok: false, error: "open", win32: 6 });
  });

  test("anything that is not a reply is discarded", () => {
    // A PowerShell warning, an XML error blob, a stray literal.
    expect(parseConsoleFontHelperReply("")).toBeNull();
    expect(parseConsoleFontHelperReply("WARNING: something")).toBeNull();
    expect(parseConsoleFontHelperReply("<Objs/>")).toBeNull();
    expect(parseConsoleFontHelperReply("{not json}")).toBeNull();
    expect(parseConsoleFontHelperReply("[1,2]")).toBeNull();
    expect(parseConsoleFontHelperReply('{"ok":"yes"}')).toBeNull();
    expect(parseConsoleFontHelperReply('{"face":"Consolas"}')).toBeNull();
  });

  test("a byte-order mark does not make a reply unreadable", () => {
    // `trim()` treats U+FEFF as whitespace, which is exactly the tolerance wanted:
    // a helper that ever prepends a BOM must not read as a dead console.
    expect(
      parseConsoleFontHelperReply('\uFEFF{"ok":true,"op":"ready"}'),
    ).toEqual({ ok: true, op: "ready" });
  });

  test("drops fields of the wrong type instead of trusting them", () => {
    const reply = parseConsoleFontHelperReply(
      '{"ok":true,"op":"read","face":42,"cellWidth":"9","cellHeight":18}',
    );
    expect(reply).toEqual({ ok: true, op: "read", cellHeight: 18 });
  });
});

describe("the helper command line", () => {
  test("encodes the whole script, so nothing depends on a shell", () => {
    const args = consoleFontHelperArgs(CONSOLE_FONT_HELPER_SCRIPT);
    const index = args.indexOf("-EncodedCommand");
    expect(index).toBeGreaterThan(0);
    const encoded = args[index + 1] ?? "";
    const decoded = Buffer.from(encoded, "base64").toString("utf16le");
    expect(decoded).toBe(CONSOLE_FONT_HELPER_SCRIPT);
    expect(decoded).toContain("SetCurrentConsoleFontEx");
    expect(decoded).toContain('CreateFileW("CONOUT$"');
    // The helper must never run in the TUI's console before it has its own: that
    // start-up is what flips the TUI to the raster font.
    expect(decoded).toContain("[HaruyukiConsoleFont]::FreeConsole()");
    expect(decoded).toContain(
      "[HaruyukiConsoleFont]::AttachConsole($attachPid)",
    );
  });

  test("runs the policy-bypassed, profile-free Windows PowerShell under SystemRoot", () => {
    expect(
      consoleFontHelperExecutable({
        SystemRoot: "D:\\Windows",
      } as NodeJS.ProcessEnv),
    ).toBe("D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(consoleFontHelperArgs("x")).toContain("-NonInteractive");
    expect(consoleFontHelperArgs("x")).toContain("-NoProfile");
  });
});

describe("openConsoleFontHelperPort", () => {
  test("starts the helper in its own hidden console and names the console to attach", async () => {
    const { spawnImpl, spawnOptions } = createFakeSpawn();
    const port = await openConsoleFontHelperPort({
      spawnImpl,
      attachPid: 4242,
    });
    if (port === null) throw new Error("port did not open");

    const captured = spawnOptions();
    expect(captured?.options.windowsHide).toBe(true);
    expect(captured?.options.detached).toBeUndefined();
    expect(captured?.options.env.HARUYUKI_CONSOLE_FONT_ATTACH_PID).toBe("4242");
    expect(captured?.options.stdio).toEqual(["pipe", "pipe", "pipe"]);
    port.close?.();
  });

  test("opens a port, reads a font and applies one", async () => {
    const { spawnImpl, helper } = createFakeSpawn();
    helper.respond = replyFor;
    const port = await openConsoleFontHelperPort({ spawnImpl });

    expect(port).not.toBeNull();
    if (port === null) return;
    expect(await port.read()).toEqual({
      face: "Consolas",
      cellWidth: 9,
      cellHeight: 18,
      family: 54,
      weight: 400,
    });
    expect(
      await port.apply({ face: "Consolas", cellHeight: 18, weight: 400 }),
    ).toBe(true);
    expect(helper.requests).toEqual([
      '{"op":"read"}',
      '{"op":"apply","face":"Consolas","cellHeight":18,"weight":400}',
    ]);
    expect(await port.listFaces?.()).toEqual(["Consolas", "NSimSun"]);
    port.close?.();
  });

  test("serializes concurrent requests, one line in flight", async () => {
    const { spawnImpl, helper } = createFakeSpawn();
    const order: string[] = [];
    helper.respond = (request) => {
      order.push(String(request.op));
      // Answer from a later macrotask so the second request would be visible
      // immediately if the port did not queue.
      return replyFor(request);
    };
    const port = await openConsoleFontHelperPort({ spawnImpl });
    if (port === null) throw new Error("port did not open");

    await Promise.all([port.read(), port.read()]);
    expect(order).toEqual(["read", "read"]);
    port.close?.();
  });

  test("an unreadable console is `null`, never an empty face", async () => {
    const { spawnImpl, helper } = createFakeSpawn();
    helper.respond = () => JSON.stringify({ ok: true, face: "" });
    const port = await openConsoleFontHelperPort({ spawnImpl });
    if (port === null) throw new Error("port did not open");

    expect(await port.read()).toBeNull();
    port.close?.();
  });

  test("a refused apply is `false`", async () => {
    const { spawnImpl, helper } = createFakeSpawn();
    helper.respond = () =>
      JSON.stringify({ ok: false, error: "set", win32: 87 });
    const port = await openConsoleFontHelperPort({ spawnImpl });
    if (port === null) throw new Error("port did not open");

    expect(
      await port.apply({ face: "Nope", cellHeight: 16, weight: 400 }),
    ).toBe(false);
    port.close?.();
  });

  test("no ready line within the startup timeout fails the port", async () => {
    const { spawnImpl, helper } = createFakeSpawn({ ready: false });
    const port = await openConsoleFontHelperPort({
      spawnImpl,
      startupTimeoutMs: 5,
    });

    expect(port).toBeNull();
    expect(helper.killed).toBe(true);
  });

  test("a helper that stops answering degrades to `null` reads and a dead port", async () => {
    const { spawnImpl, helper } = createFakeSpawn();
    helper.respond = () => null;
    const port = await openConsoleFontHelperPort({
      spawnImpl,
      requestTimeoutMs: 5,
    });
    if (port === null) throw new Error("port did not open");

    expect(await port.read()).toBeNull();
    expect(
      await port.apply({ face: "Consolas", cellHeight: 16, weight: 400 }),
    ).toBe(false);
    port.close?.();
    expect(helper.killed).toBe(true);
  });

  test("a helper that exits is treated as gone", async () => {
    const { spawnImpl, helper } = createFakeSpawn();
    helper.respond = replyFor;
    const port = await openConsoleFontHelperPort({ spawnImpl });
    if (port === null) throw new Error("port did not open");

    helper.emit("exit", 1);
    expect(await port.read()).toBeNull();
    port.close?.();
  });

  test("close ends the child and further queries answer null", async () => {
    const { spawnImpl, helper } = createFakeSpawn();
    helper.respond = replyFor;
    const port = await openConsoleFontHelperPort({ spawnImpl });
    if (port === null) throw new Error("port did not open");

    port.close?.();
    port.close?.();
    expect(helper.killed).toBe(true);
    expect(await port.read()).toBeNull();
  });
});
