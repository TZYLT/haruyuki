import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import type {
  FileAutocompleteItem,
  FileAutocompleteSuggestions,
} from "@/cli/helpers/file-autocomplete";
import {
  type InkTty,
  mountInkTty,
  resetInkTtyState,
} from "@/test-utils/ink-tty";

/**
 * `FileAutocomplete`, judged on its frame.
 *
 * The suggestions come from `fd` through `FileAutocompleteProvider`, and this
 * file replaces that one module rather than spawning anything: `fd` is not on
 * PATH in the test environment (the harness redirects HOME, so the local install
 * is invisible), the provider's own suite writes a shebang fake and is therefore
 * skipped on Windows, and the rendering rules below are what is uncovered --
 * which glyph a row gets, when a description is worth printing, and what happens
 * past ten matches. The module mock is the sanctioned seam for a dependency the
 * component constructs itself; the file is registered in
 * `scripts/isolated-unit-tests.json`, because a Bun module mock is global to its
 * worker.
 *
 * What a frame *cannot* show on this face is the selection: `AutocompleteItem`
 * marks it with colour and bold only, and this component always paints the first
 * ten matches, so navigating never moves the frame. The hook's own suite owns the
 * cursor; here the ten-row cap and its stability are what is checkable.
 */

const manifestItems: FileAutocompleteItem[] = [];

mock.module("@/cli/helpers/file-autocomplete", () => ({
  FileAutocompleteProvider: class {
    async getSuggestions(): Promise<FileAutocompleteSuggestions | null> {
      if (manifestItems.length === 0) return null;
      return { items: [...manifestItems], prefix: "@" };
    }
  },
  applyPiFileCompletion: () => ({ value: "stub", cursorPosition: 0 }),
}));

const { FileAutocomplete } = await import("./FileAutocomplete");

afterAll(() => {
  mock.restore();
});

const settle = (ms = 200) => new Promise((resolve) => setTimeout(resolve, ms));

function setItems(items: FileAutocompleteItem[]): void {
  manifestItems.length = 0;
  manifestItems.push(...items);
}

function mountPopup(input: string): InkTty {
  return mountInkTty(
    <FileAutocomplete
      currentInput={input}
      cursorPosition={input.length}
      fdPath="fd"
      workingDirectory="/tmp/haruyuki-file-autocomplete"
      onApplyCompletion={() => {}}
    />,
    { columns: 100, rows: 40 },
  );
}

async function frame(input: string, items: FileAutocompleteItem[]) {
  setItems(items);
  const tty = mountPopup(input);
  try {
    await settle();
    return await tty.rows();
  } finally {
    tty.stop();
  }
}

function file(label: string, description?: string): FileAutocompleteItem {
  return { value: `@${label}`, label, description };
}

afterEach(resetInkTtyState);

describe("FileAutocomplete on the frame", () => {
  test("a row is the glyph, the label, and only a description that says something new", async () => {
    // The provider sets a file's description to its path, which for a top-level
    // file is the label again; printing both would just repeat the row.
    expect(
      await frame("@", [
        file("README.md", "README.md"),
        file("app.ts", "src/app.ts"),
      ]),
    ).toEqual([
      "File autocomplete (↑↓ navigate, Tab/Enter select):",
      "  📄 README.md",
      "  📄 app.ts src/app.ts",
    ]);
  });

  test("a directory keeps its slash and always shows its path", async () => {
    // The provider's directory row is `label: "src/"`, `description: "src"`, and
    // those two always differ -- so a directory is the case where the description
    // is guaranteed to print.
    expect(await frame("@sr", [file("src/", "src")])).toEqual([
      "File autocomplete (↑↓ navigate, Tab/Enter select):",
      "  📁 src/ src",
    ]);
  });

  test("more than ten matches are capped, with the rest counted", async () => {
    const items = Array.from({ length: 12 }, (_, index) =>
      file(`file-${index + 1}.ts`, `deep/file-${index + 1}.ts`),
    );

    const rows = await frame("@", items);

    expect(rows).toHaveLength(12);
    expect(rows[1]).toBe("  📄 file-1.ts deep/file-1.ts");
    expect(rows[10]).toBe("  📄 file-10.ts deep/file-10.ts");
    // The count row is not a list item, so it carries no item gutter.
    expect(rows[11]).toBe("... and 2 more");
  });

  test("navigating does not reflow the popup", async () => {
    // The row set is fixed to the first ten matches while the cursor moves inside
    // them, so twelve ↓ leaves the frame exactly as it was. That is the whole of
    // what "navigation" can mean on this face: which row is selected is colour and
    // bold, and no frame carries it (the hook's suite owns the cursor). The guard
    // is for a change that made this popup scroll its window instead -- that would
    // move the rows under the cursor and trip here.
    const items = Array.from({ length: 12 }, (_, index) =>
      file(`file-${index + 1}.ts`, `deep/file-${index + 1}.ts`),
    );
    setItems(items);
    const tty = mountPopup("@");
    try {
      await settle();
      const before = await tty.rows();

      for (let step = 0; step < 12; step += 1) {
        await tty.press("\u001b[B");
        await settle(50);
      }
      const after = await tty.rows();

      expect(after).toEqual(before);
    } finally {
      tty.stop();
    }
  });

  test("no `@` and no match both draw nothing", async () => {
    expect(await frame("hello", [file("README.md", "README.md")])).toEqual([]);
    expect(await frame("@zz", [])).toEqual([]);
  });
});
