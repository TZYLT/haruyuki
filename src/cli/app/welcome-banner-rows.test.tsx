/**
 * The welcome banner's height, against the component that draws it.
 *
 * It is the one transcript item whose height used to be a **constant guess**: 12
 * rows for a 4-row logo beside 3 text rows. It is also the item the machine's "big
 * blocks of text vanish while scrolling" window started at (2026-10-20,
 * `blankTail=14`): the row model claimed twelve rows, the band got five, and the
 * difference stayed empty at the band's bottom, because a viewport that believes it
 * is filled never asks for more items.
 *
 * The banner cannot be measured exactly from the item alone — its text column
 * carries the model, the auth method and the working directory, and the memfs
 * warning can add a row — so the guard is a differential one: render the real
 * `WelcomeScreen` at a known width and hold the model to the same height, within
 * the one row the model is allowed to be off.
 *
 * Lives in its own file rather than in `row-model.fidelity.test.tsx` because that
 * suite is at the 1000-line ceiling.
 */

import { expect, test } from "bun:test";
import { CLI_GLYPHS } from "@/cli/helpers/glyphs";
import { mountInkTty } from "@/test-utils/ink-tty";
import { measureTranscriptItemRows } from "./row-model";
import { TranscriptItemView } from "./TranscriptItem";
import type { StaticItem } from "./types";

const COLUMNS = 120;
const ROWS = 50;

async function paintedRows(item: StaticItem): Promise<number> {
  const shell = mountInkTty(
    <TranscriptItemView
      item={item}
      index={0}
      columns={COLUMNS}
      statusLinePrompt=">"
      showCompactionsEnabled={false}
      precomputedDiffs={new Map()}
    />,
    { columns: COLUMNS, rows: ROWS },
  );
  try {
    return (await shell.rows()).length;
  } finally {
    shell.stop();
  }
}

function predictedRows(item: StaticItem): number {
  return measureTranscriptItemRows(item, {
    columns: COLUMNS,
    index: 0,
    terminalRows: ROWS,
    diffs: new Map(),
    userPromptPrefix: `${CLI_GLYPHS.prompt} `,
  });
}

const WELCOME: StaticItem = {
  kind: "welcome",
  id: "welcome-1",
  snapshot: {
    continueSession: true,
    agentState: null,
    startupHasAvailableLocalModels: true,
    terminalWidth: COLUMNS,
  },
};

test("the welcome banner is five rows, and the model says so", async () => {
  const painted = await paintedRows(WELCOME);
  const predicted = predictedRows(WELCOME);
  // The old constant was 12 for this banner: a blank band's worth of difference.
  expect({ predicted, painted }).toEqual({ predicted: 5, painted: 4 });
  // A frame read trims the banner's trailing blank row, so four is the layout of a
  // five-row box; the model is allowed one row of that.
  expect(Math.abs(painted - predicted)).toBeLessThanOrEqual(1);
});

test("the banner does not grow a row for a frame that reads its last blank line", async () => {
  // The item at index > 0 gets the inter-item gap on top of the banner's own
  // margin, which is the case the viewport actually fits it in.
  const painted = await paintedRows(WELCOME);
  expect(painted).toBeLessThanOrEqual(predictedRows(WELCOME));
});
