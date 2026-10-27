/**
 * `/topic list --all` and `/topic search <kw>` at the submit boundary.
 *
 * Two claims, and both are about what the command must *not* do:
 *
 * - it opens the face rather than printing the list (§5.11.10 — a registry
 *   handler cannot open an overlay, route C-23);
 * - `search` never writes a marker. The registry used to read the first word of
 *   `/topic …` as a title, so a search recorded a topic called "search"
 *   (route C-22). The assertion below is on the transcript's marker count, not
 *   on the command's return value, because the bug's damage was a row on disk.
 *
 * The backend is a real `LocalBackend` on a temporary root: `listTopics` is what
 * proves nothing was written, and the index behind `search` only exists under a
 * local storage root.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { __testSetBackend } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import {
  handleTopicOverlayCommand,
  type TopicOverlayCommandContext,
} from "@/cli/app/submit-topic-commands";
import type { ActiveOverlay, AppCommandRunner } from "@/cli/app/types";
import { TOPIC_COMMAND_LOCAL_ONLY } from "@/cli/commands/topic";
import {
  cleanupCompactHarness,
  localConversation,
} from "@/test-utils/compact-command-harness";

interface Opened {
  overlay: NonNullable<ActiveOverlay>;
  input: string;
  openingOutput: string;
  dismissOutput: string;
}

interface Finished {
  input: string;
  output: string;
  success: boolean;
}

function context(): {
  ctx: TopicOverlayCommandContext;
  opened: Opened[];
  searches: string[];
  finished: Finished[];
} {
  const opened: Opened[] = [];
  const searches: string[] = [];
  const finished: Finished[] = [];
  const ctx: TopicOverlayCommandContext = {
    commandRunner: {
      start: (input: string) => ({
        id: "cmd-1",
        input,
        update: () => {},
        finish: (output: string, success = true) => {
          finished.push({ input, output, success });
        },
        fail: (output: string) => {
          finished.push({ input, output, success: false });
        },
      }),
      getHandle: () => null,
    } as unknown as AppCommandRunner,
    openOverlay: (overlay, input, openingOutput, dismissOutput) => {
      opened.push({ overlay, input, openingOutput, dismissOutput });
      return {
        id: "cmd-1",
        input,
        update: () => {},
        finish: () => {},
        fail: () => {},
      } as never;
    },
    setSearchQuery: (value) => {
      searches.push(typeof value === "function" ? "" : value);
    },
  };
  return { ctx, opened, searches, finished };
}

afterEach(async () => {
  __testSetBackend(null);
  await cleanupCompactHarness();
});

describe("handleTopicOverlayCommand", () => {
  test("/topic list --all opens the panel and prints no list", async () => {
    const local = await localConversation(4);
    local.markTopic("Alpha");
    const { ctx, opened, finished } = context();

    const result = await handleTopicOverlayCommand("/topic list --all", ctx);

    expect(result).toEqual({ submitted: true });
    expect(opened).toEqual([
      {
        overlay: "topic-list",
        input: "/topic list --all",
        openingOutput: "Opening the topic list...",
        dismissOutput: "Topic list dismissed",
      },
    ]);
    // Nothing is printed here: the row belongs to the overlay (`openOverlay`
    // starts it), and the list itself is drawn by the face.
    expect(finished).toEqual([]);
  });

  test("/topic search <kw> opens the search face with the keyword", async () => {
    await localConversation(4);
    const { ctx, opened, searches, finished } = context();

    const result = await handleTopicOverlayCommand(
      "/topic search auth token",
      ctx,
    );

    expect(result).toEqual({ submitted: true });
    expect(searches).toEqual(["auth token"]);
    expect(opened.map((entry) => entry.overlay)).toEqual(["topic-search"]);
    expect(finished).toEqual([]);
  });

  test("/topic search writes no marker (the C-22 bug)", async () => {
    const local = await localConversation(4);
    local.markTopic("Alpha");
    const { ctx } = context();
    const markersBefore = local.backend.listTopics(
      local.conversationId,
      local.agentId,
    ).markers.length;

    await handleTopicOverlayCommand("/topic search deploy", ctx);
    await handleTopicOverlayCommand("/topic search", ctx);
    await handleTopicOverlayCommand("/topic list --all", ctx);

    const markers = local.backend.listTopics(
      local.conversationId,
      local.agentId,
    ).markers;
    expect(markers).toHaveLength(markersBefore);
    // Nor did a marker called "search" appear under any spelling.
    expect(markers.map((view) => view.marker.title)).toEqual(["Alpha"]);
  });

  test("the other /topic forms are not claimed", async () => {
    await localConversation(4);
    const { ctx, opened } = context();

    // A title, the plain list, its help, an unknown option and the retired alias
    // all belong to the registry — claiming them here would swallow its answers.
    for (const input of [
      "/topic Auth token refresh",
      "/topic list",
      "/topic list help",
      "/topic list --all extra",
      "/topics",
      "/topic searchx",
    ]) {
      expect(await handleTopicOverlayCommand(input, ctx)).toBeNull();
    }
    expect(opened).toEqual([]);
  });

  test("a backend with no local storage root is refused in words, not opened", async () => {
    // `queryTopicIndex` falls back to the real `~/.haruyuki` root when it is not
    // given one, so a face that cannot name its root must not be opened (《31》A1).
    __testSetBackend(new FakeHeadlessBackend());
    const { ctx, opened, finished } = context();

    const result = await handleTopicOverlayCommand("/topic list --all", ctx);

    expect(result).toEqual({ submitted: true });
    expect(opened).toEqual([]);
    // The refusal is the shared copy the registry path also returns, so the
    // listener and the TUI explain the same thing.
    expect(finished).toEqual([
      {
        input: "/topic list --all",
        output: TOPIC_COMMAND_LOCAL_ONLY,
        success: true,
      },
    ]);
  });
});
