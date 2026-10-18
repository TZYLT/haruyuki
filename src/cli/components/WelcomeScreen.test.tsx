import { afterEach, describe, expect, test } from "bun:test";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";
import { getVersion } from "@/version";
import { WelcomeScreen } from "./WelcomeScreen";

/**
 * `WelcomeScreen`, judged on the frame.
 *
 * This face was rendered by the app and asserted nowhere. Its own content is one
 * column of four rows -- the version, the auth label, a status line, and
 * sometimes a warning -- next to a logo that is **blank on purpose** (the brand
 * assets the upstream LICENSE excludes; `AnimatedLogo` says so and asks for this
 * fork's own mark when it has one). So the rows below are the column that is
 * actually information, and the logo's trailing rows are what the harness drops.
 *
 * Two of its branches are out of reach from here, honestly recorded: the memfs
 * warning and the `llm_config` model name both need an agent **id**, and the
 * component then reads `settingsManager.isMemfsEnabled(id)` at render time
 * without a guard, so mounting it with an id throws `Settings not initialized`
 * unless the global settings singleton is initialized first. Wiring that up here
 * would make this file a settings-singleton test; the loading contract and the
 * startup-model decision are what it covers instead.
 */

const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

async function frame(props: {
  loadingState:
    | "loading_profiles"
    | "assembling"
    | "initializing"
    | "checking"
    | "ready";
  continueSession?: boolean;
  startupHasAvailableLocalModels?: boolean;
}): Promise<string[]> {
  const tty = mountInkTty(
    <WelcomeScreen
      loadingState={props.loadingState}
      continueSession={props.continueSession}
      agentState={null}
      startupHasAvailableLocalModels={
        props.startupHasAvailableLocalModels ?? true
      }
    />,
    { columns: 100, rows: 40 },
  );
  try {
    await settle();
    return await tty.rows();
  } finally {
    tty.stop();
  }
}

afterEach(resetInkTtyState);

describe("WelcomeScreen on the frame", () => {
  test("each loading state says what is happening", async () => {
    // The status row is the third row of the info column, indented past the blank
    // logo (one column of padding, ten of logo, two of gap).
    const cases = [
      ["loading_profiles", "Loading pinned agents..."],
      ["assembling", "Assembling tools..."],
      ["checking", "Checking for pending approvals..."],
    ] as const;

    for (const [state, message] of cases) {
      const rows = await frame({ loadingState: state });
      expect(rows[1]).toBe(`             Haruyuki v${getVersion()}`);
      expect(rows[3]).toBe(`             ${message}`);
    }
  });

  test("initializing says whether it resumes or creates", async () => {
    // The same state, two things the user needs to tell apart.
    expect((await frame({ loadingState: "initializing" }))[3]).toBe(
      "             Creating agent...",
    );
    expect(
      (await frame({ loadingState: "initializing", continueSession: true }))[3],
    ).toBe("             Resuming agent...");
  });

  test("ready swaps the status row for the working directory", async () => {
    const rows = await frame({ loadingState: "ready" });

    // The harness redirects HOME to a temp directory, so the working directory is
    // not under it and gets no `~`.
    expect(rows[3]).toBe(`             ${process.cwd()}`);
    expect(rows[1]).toBe(`             Haruyuki v${getVersion()}`);
  });

  test("the model row follows local-model availability", async () => {
    // This fork is local-only (`isLocalBackendEnabled()` is a literal `true`), so
    // the auth label is always `Local` and the startup decision is the only thing
    // that can put a model name -- or the absence of one -- on that row.
    expect((await frame({ loadingState: "ready" }))[2]).toBe(
      "             Local",
    );
    expect(
      (
        await frame({
          loadingState: "ready",
          startupHasAvailableLocalModels: false,
        })
      )[2],
    ).toBe("             No model selected · Local");
  });
});
