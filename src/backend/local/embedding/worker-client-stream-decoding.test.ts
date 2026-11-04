import { afterAll, describe, expect, test } from "bun:test";
import {
  EmbeddingWorkerClient,
  type EmbeddingWorkerClientOptions,
} from "./worker-client";
import type {
  EmbeddingWorkerExit,
  EmbeddingWorkerProcessHandle,
} from "./worker-process";

/**
 * Byte-level stream decoding regressions for the embedding worker client.
 *
 * The client decodes arbitrary stdout/stderr chunks into text (a multi-byte
 * UTF-8 character can be split across two chunks), so this file drives an
 * injected child whose two streams are fed raw bytes in a controlled order.
 * Kept apart from `worker-client.test.ts` (spawn/handshake/lifecycle) so both
 * files stay under the 1,000-line ceiling.
 */

const clients: EmbeddingWorkerClient[] = [];

afterAll(() => {
  for (const client of clients.splice(0)) client.dispose();
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for the worker stream state.");
    }
    await sleep(5);
  }
}

interface ByteScriptedStream {
  readonly stream: AsyncIterable<string | Uint8Array>;
  push(chunk: string | Uint8Array): void;
  /** True while the pump waits for its next chunk (the previous one is done). */
  readonly waiting: () => boolean;
  readonly close: () => void;
}

/** Async byte stream the test drives chunk by chunk (split UTF-8 on purpose). */
function createByteScriptedStream(): ByteScriptedStream {
  const queue: (string | Uint8Array)[] = [];
  let notify: (() => void) | null = null;
  let closed = false;
  return {
    stream: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const next = queue.shift();
          if (next !== undefined) {
            yield next;
            continue;
          }
          if (closed) return;
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
          notify = null;
        }
      },
    },
    push(chunk: string | Uint8Array): void {
      queue.push(chunk);
      const resolve = notify;
      notify = null;
      resolve?.();
    },
    waiting: () => notify !== null,
    close(): void {
      closed = true;
      const resolve = notify;
      notify = null;
      resolve?.();
    },
  };
}

interface ByteScriptedHandle {
  readonly handle: EmbeddingWorkerProcessHandle;
  readonly stdout: ByteScriptedStream;
  readonly stderr: ByteScriptedStream;
  readonly killed: () => boolean;
}

/** Injected child whose stdout and stderr are driven as raw byte chunks. */
function createByteScriptedHandle(): ByteScriptedHandle {
  const stdout = createByteScriptedStream();
  const stderr = createByteScriptedStream();
  let killed = false;
  let resolveExit: (exit: EmbeddingWorkerExit) => void = () => {};
  const exited = new Promise<EmbeddingWorkerExit>((resolve) => {
    resolveExit = resolve;
  });
  return {
    handle: {
      pid: 9_998,
      stdout: stdout.stream,
      stderr: stderr.stream,
      write(): void {},
      kill(): void {
        if (killed) return;
        killed = true;
        stdout.close();
        stderr.close();
        resolveExit({ code: null, signal: "SIGKILL" });
      },
      exited,
    },
    stdout,
    stderr,
    killed: () => killed,
  };
}

function createByteClient(
  scripted: ByteScriptedHandle,
  options: Partial<EmbeddingWorkerClientOptions> = {},
): EmbeddingWorkerClient {
  const client = new EmbeddingWorkerClient({
    workerPath: "byte-scripted-worker.js",
    spawn: () => scripted.handle,
    handshakeTimeoutMs: 2_000,
    initTimeoutMs: 2_000,
    restart: false,
    ...options,
  });
  clients.push(client);
  return client;
}

describe("EmbeddingWorkerClient: byte streams", () => {
  test("decodes stdout and stderr with independent UTF-8 state", async () => {
    const scripted = createByteScriptedHandle();
    const client = createByteClient(scripted);
    const starting = client.start();

    // The first two bytes of 漢 (E6 BC A2) on stderr end mid-character. If
    // stdout and stderr shared a decoder, the pending sequence would be
    // completed by stdout's first frame byte and the ready frame would be
    // rejected as a protocol desync; independent decoders keep both intact.
    scripted.stderr.push(Uint8Array.from([0xe6, 0xbc]));
    await waitForCondition(() => scripted.stderr.waiting());
    scripted.stdout.push(
      new TextEncoder().encode(
        `${JSON.stringify({
          type: "ready",
          protocol: 1,
          pid: 9_998,
          runtime: "node",
          startedAt: 1,
        })}\n`,
      ),
    );
    await expect(starting).resolves.toMatchObject({ type: "ready" });

    scripted.stderr.push(Uint8Array.from([0xa2, 0x0a]));
    await waitForCondition(() => client.stderrTail().includes("漢"));
    expect(client.stderrTail()).toBe("漢");
    expect(client.stderrTail()).not.toContain("\uFFFD");
  });

  test("keeps a later frame parseable while stderr holds half a character", async () => {
    const scripted = createByteScriptedHandle();
    const client = createByteClient(scripted);
    const starting = client.start();
    scripted.stdout.push(
      new TextEncoder().encode(
        `${JSON.stringify({
          type: "ready",
          protocol: 1,
          pid: 9_998,
          runtime: "node",
          startedAt: 1,
        })}\n`,
      ),
    );
    await starting;

    // Half of 漢 is pending on stderr; a frame that arrives on stdout next must
    // still parse (a shared decoder would splice the two and fail the stream).
    scripted.stderr.push(Uint8Array.from([0xe6, 0xbc]));
    await waitForCondition(() => scripted.stderr.waiting());
    const errorFrame = new TextEncoder().encode(
      `${JSON.stringify({
        type: "error",
        id: 99,
        error: { code: "embed-failed", message: "失败" },
      })}\n`,
    );
    scripted.stdout.push(errorFrame);

    await waitForCondition(() => client.workerError !== null);
    scripted.stderr.push(Uint8Array.from([0xa2, 0x0a]));
    await waitForCondition(() => client.stderrTail() === "漢");
    expect(client.protocolError).toBeNull();
    expect(client.workerError?.message).toBe("失败");
    expect(scripted.killed()).toBe(false);
  });
});
