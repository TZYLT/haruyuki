import { describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { render, Text } from "ink";
import type { PageSlice } from "@/cli/overlay/pagination";
import {
  type PagedListController,
  type UsePagedListOptions,
  usePagedList,
} from "@/cli/overlay/use-pagination";

/**
 * The page machine's React half, on real fetches.
 *
 * The pure transitions are pinned in `pagination.test.ts`; what can only be seen
 * here is the wiring — that a first load replaces, that a second `loadMore` while
 * one is in flight does not fetch, and that a response a newer load has already
 * superseded does not land on top of it (the generation guard, which is the whole
 * reason this hook exists rather than a `useReducer` at each call site).
 */

class NullOutput extends Writable {
  columns = 80;
  rows = 24;
  isTTY = true;

  override _write(
    _chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    callback();
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

interface Row {
  id: string;
}

const row = (id: string): Row => ({ id });

function rows(...ids: string[]): Row[] {
  return ids.map(row);
}

/** A fetch whose completion the test decides. */
function deferredPage() {
  let settle: ((page: PageSlice<Row>) => void) | undefined;
  let fail: ((error: Error) => void) | undefined;
  const promise = new Promise<PageSlice<Row>>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  return {
    promise,
    resolve: (page: PageSlice<Row>) => settle?.(page),
    reject: (error: Error) => fail?.(error),
  };
}

function mountList(options: () => UsePagedListOptions<Row>) {
  const latest: { current: PagedListController<Row> | undefined } = {
    current: undefined,
  };

  function Probe() {
    latest.current = usePagedList(options());
    return <Text>probe</Text>;
  }

  const stdout = new NullOutput() as unknown as NodeJS.WriteStream;
  const stdin = new Readable({ read() {} }) as NodeJS.ReadStream;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;

  const instance = render(<Probe />, {
    stdin,
    stdout,
    debug: false,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  return {
    /** The controller as of the last render. */
    async controller(): Promise<PagedListController<Row>> {
      await tick();
      if (!latest.current) throw new Error("probe did not mount");
      return latest.current;
    },
    stop() {
      instance.unmount();
      instance.cleanup();
    },
  };
}

describe("usePagedList", () => {
  test("the first page replaces, and its prefix is not part of what it resolves", async () => {
    const calls: (string | null)[] = [];
    const probe = mountList(() => ({
      keyOf: (item) => item.id,
      pageSize: 2,
      fetchPage: async (after) => {
        calls.push(after);
        return { items: rows("a", "b"), prefix: rows("default") };
      },
    }));

    const first = await probe.controller();
    const page = await first.loadFirst();
    const after = await probe.controller();

    expect(calls).toEqual([null]);
    expect(page?.map((item) => item.id)).toEqual(["a", "b"]);
    expect(after.items.map((item) => item.id)).toEqual(["default", "a", "b"]);
    expect(after.status).toBe("ready");
    expect(after.canLoadMore).toBe(true);
    probe.stop();
  });

  test("a short page ends the list", async () => {
    const probe = mountList(() => ({
      keyOf: (item) => item.id,
      pageSize: 5,
      fetchPage: async () => ({ items: rows("a", "b") }),
    }));

    const controller = await probe.controller();
    await controller.loadFirst();
    const after = await probe.controller();

    expect(after.canLoadMore).toBe(false);
    probe.stop();
  });

  test("loadMore appends, and a second one while it is in flight does not fetch", async () => {
    const calls: (string | null)[] = [];
    const second = deferredPage();
    const probe = mountList(() => ({
      keyOf: (item) => item.id,
      pageSize: 2,
      fetchPage: async (after) => {
        calls.push(after);
        if (after === null) return { items: rows("a", "b") };
        return second.promise;
      },
    }));

    const first = await probe.controller();
    await first.loadFirst();
    const loaded = await probe.controller();

    const one = loaded.loadMore();
    const two = loaded.loadMore();
    second.resolve({ items: rows("c", "d") });
    await Promise.all([one, two]);
    const after = await probe.controller();

    // Two calls to `loadMore`, one fetch: the second page would have been asked
    // for with the same cursor, which appends it twice.
    expect(calls).toEqual([null, "b"]);
    expect(after.items.map((item) => item.id)).toEqual(["a", "b", "c", "d"]);
    probe.stop();
  });

  test("a response a newer load superseded does not land", async () => {
    const stale = deferredPage();
    let call = 0;
    const probe = mountList(() => ({
      keyOf: (item) => item.id,
      pageSize: 2,
      fetchPage: async () => {
        call += 1;
        if (call === 1) return stale.promise;
        return { items: rows("new", "newer") };
      },
    }));

    const controller = await probe.controller();
    const abandoned = controller.loadFirst();
    const winning = controller.loadFirst();
    const won = await winning;
    // The first fetch answers last, which is exactly the race the guard is for.
    stale.resolve({ items: rows("stale", "staler") });
    await abandoned;
    const after = await probe.controller();

    expect(won?.map((item) => item.id)).toEqual(["new", "newer"]);
    expect(after.items.map((item) => item.id)).toEqual(["new", "newer"]);
    probe.stop();
  });

  test("a failed first load reports the error and keeps the list retryable", async () => {
    let call = 0;
    const probe = mountList(() => ({
      keyOf: (item) => item.id,
      pageSize: 2,
      fetchPage: async () => {
        call += 1;
        if (call === 1) throw new Error("backend is offline");
        return { items: rows("a", "b") };
      },
    }));

    const controller = await probe.controller();
    expect(await controller.loadFirst()).toBeNull();
    const failed = await probe.controller();

    expect(failed.status).toBe("error");
    expect(failed.error).toBe("backend is offline");

    await failed.loadFirst();
    const retried = await probe.controller();

    expect(retried.status).toBe("ready");
    expect(retried.error).toBeNull();
    expect(retried.items.map((item) => item.id)).toEqual(["a", "b"]);
    probe.stop();
  });

  test("two updates in one tick both apply, because the second sees the first", async () => {
    const probe = mountList(() => ({
      keyOf: (item) => item.id,
      pageSize: 3,
      fetchPage: async () => ({ items: rows("a", "b", "c") }),
    }));

    const controller = await probe.controller();
    await controller.loadFirst();
    const loaded = await probe.controller();

    loaded.setItems((items) => items.filter((item) => item.id !== "a"));
    loaded.setItems((items) => items.filter((item) => item.id !== "b"));
    const after = await probe.controller();

    expect(after.items.map((item) => item.id)).toEqual(["c"]);
    probe.stop();
  });
});
