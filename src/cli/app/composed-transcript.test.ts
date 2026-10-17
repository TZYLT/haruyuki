import { describe, expect, test } from "bun:test";
import {
  composeTranscript,
  composeTranscriptItems,
  transcriptCoreIds,
} from "@/cli/app/composed-transcript";
import type { StaticItem } from "@/cli/app/types";

function user(id: string, text = id): StaticItem {
  return { kind: "user", id, text };
}

/** A committed list whose index reads are counted, as a frame's cost gate wants it. */
function countedHistory(count: number): {
  items: StaticItem[];
  reads: () => number;
  reset: () => void;
} {
  const items = Array.from({ length: count }, (_, index) =>
    user(`item-${index}`, `row ${index}`),
  );
  let reads = 0;
  const instrumented = new Proxy(items, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  return {
    items: instrumented,
    reads: () => reads,
    reset: () => {
      reads = 0;
    },
  };
}

describe("composing the two lists", () => {
  test("drops a row the core already has, keeping the core's copy", () => {
    const core: StaticItem[] = [user("dup", "from the core")];
    const older: StaticItem[] = [user("dup", "from a page")];
    expect(composeTranscriptItems(older, core)).toEqual([
      user("dup", "from the core"),
    ]);
  });

  test("keeps the newest copy of a row two pages both produced", () => {
    const older: StaticItem[] = [
      user("dup", "the page fetched later"),
      user("only-old", "older"),
      user("dup", "the page fetched first"),
    ];
    expect(composeTranscriptItems(older, [])).toEqual([
      user("dup", "the page fetched later"),
      user("only-old", "older"),
    ]);
  });

  test("is the core list, unchanged, while nothing has been paged", () => {
    const core: StaticItem[] = [{ kind: "separator", id: "s" }];
    expect(composeTranscriptItems([], core)).toEqual(core);
  });
});

describe("the composed view", () => {
  test("addresses older rows, then the core, then the live turn", () => {
    const view = composeTranscript({
      older: [user("o0"), user("o1")],
      committed: [user("c0"), user("c1"), user("c2")],
      live: [user("l0")],
    });

    expect(view.length).toBe(6);
    expect(Array.from({ length: 6 }, (_, index) => view.at(index)?.id)).toEqual(
      ["o0", "o1", "c0", "c1", "c2", "l0"],
    );
    expect(view.at(-1)).toBeUndefined();
    expect(view.at(6)).toBeUndefined();
  });

  test("a live row the core also draws is not drawn twice", () => {
    const view = composeTranscript({
      older: [user("dup"), user("kept")],
      committed: [user("c")],
      live: [user("dup")],
    });

    expect(
      Array.from({ length: view.length }, (_, i) => view.at(i)?.id),
    ).toEqual(["kept", "c", "dup"]);
  });

  test("slice clamps to the composition and keeps the order", () => {
    const view = composeTranscript({
      older: [user("o0")],
      committed: [user("c0"), user("c1")],
      live: [],
    });

    expect(view.slice(-2, 2).map((item) => item.id)).toEqual(["o0", "c0"]);
    expect(view.slice(1, 99).map((item) => item.id)).toEqual(["c0", "c1"]);
    expect(view.slice(3, 1)).toEqual([]);
    expect(view.slice(0, view.length)).toEqual([
      user("o0"),
      user("c0"),
      user("c1"),
    ]);
  });

  test("reading a row does not touch the rows around it", () => {
    const history = countedHistory(20_000);
    const view = composeTranscript({
      older: [],
      committed: history.items,
      live: [],
      committedIds: transcriptCoreIds(history.items),
    });
    history.reset();

    expect(view.at(15_000)?.id).toBe("item-15000");
    // One index read for the row the caller asked for, and nothing else: the
    // composition holds the list, it does not copy it.
    expect(history.reads()).toBe(1);

    const band = view.slice(15_000, 15_010);
    expect(band.length).toBe(10);
    expect(history.reads()).toBe(11);
  });

  test("the ids a caller hands in are the ones the dedupe uses", () => {
    const older = [user("dup"), user("kept")];
    const committed = [user("dup")];
    const withIds = composeTranscript({
      older,
      committed,
      live: [],
      committedIds: transcriptCoreIds(committed),
    });
    const withoutIds = composeTranscript({ older, committed, live: [] });

    const ids = (view: {
      length: number;
      at(i: number): StaticItem | undefined;
    }) => Array.from({ length: view.length }, (_, index) => view.at(index)?.id);
    expect(ids(withIds)).toEqual(ids(withoutIds));
  });
});
