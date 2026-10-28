/**
 * `/topic list`, `/topic list --context`, `/topic list --all` and
 * `/topic search <kw>` — the topic faces that must open an overlay, which a
 * registry handler cannot do (route C-23).
 *
 * A registry handler returns a string; `AppView` mounts a face. So the submit
 * layer is where these four commands are claimed, exactly as `/search` is: the
 * registry entry stays as the answer for the channels that have no terminal
 * (listener, headless), and the TUI intercepts before it.
 *
 * Since 2026-10-28 all three list forms open the **same** panel, on the view the
 * command names; Tab switches between them from there. The other half of the job
 * is *not* claiming too much: `/topic list help`, an unknown option, or both
 * `--all` and `--context` belong to the registry, which names the problem —
 * claiming them here would swallow the refusal.
 *
 * The dispatch also has to keep `/topic <title>` (a marker write) out of this
 * file: the registry's `/topic` entry treats its first word as a title, and
 * before the `search` branch existed `/topic search deploy` recorded a marker
 * called "search" (C-22).
 */
import type { Dispatch, SetStateAction } from "react";
import { getBackend } from "@/backend";
import type { CommandHandle } from "@/cli/commands/runner";
import { TOPIC_COMMAND_LOCAL_ONLY } from "@/cli/commands/topic";
import type { TopicPanelView } from "@/cli/helpers/topic-panel";
import type { ActiveOverlay, AppCommandRunner } from "./types";

/**
 * What these commands need from the submit environment.
 *
 * Deliberately narrower than `SubmitHandlerContext`: the real context satisfies
 * it structurally, so the call site passes `ctx` unchanged, while a test can
 * build five fields instead of eighty. `submit-navigation-commands.ts` and
 * `submit-profile-commands.ts` do the same.
 */
export interface TopicOverlayCommandContext {
  commandRunner: AppCommandRunner;
  openOverlay: (
    overlay: NonNullable<ActiveOverlay>,
    input: string,
    openingOutput: string,
    dismissOutput: string,
  ) => CommandHandle;
  setSearchQuery: Dispatch<SetStateAction<string>>;
}

/** The overlay id and the opening/dismissal copy, one per panel view. */
const LIST_FORMS: Record<
  TopicPanelView,
  { overlay: NonNullable<ActiveOverlay>; opening: string; dismissed: string }
> = {
  blocks: {
    overlay: "topic-blocks",
    opening: "Opening the topic blocks...",
    dismissed: "Topic list dismissed",
  },
  context: {
    overlay: "topic-context",
    opening: "Opening this conversation's markers...",
    dismissed: "Topic marker list dismissed",
  },
  all: {
    overlay: "topic-all",
    opening: "Opening every topic marker...",
    dismissed: "Topic list dismissed",
  },
};

/**
 * Which panel view a `/topic list …` invocation opens, or `null` for a form the
 * registry owns.
 *
 * Only the two documented flags are claimed. Anything else — `help`, an unknown
 * option, both flags at once — falls through so the registry can refuse it by
 * name instead of the TUI silently picking a view.
 */
export function claimedListView(
  parts: readonly string[],
): TopicPanelView | null {
  if (parts[1]?.toLowerCase() !== "list") return null;
  if (parts.length === 2) return "blocks";
  if (parts.length !== 3) return null;
  if (parts[2] === "--all") return "all";
  if (parts[2] === "--context") return "context";
  return null;
}

/**
 * Claim the command and open its face, or answer `null` so the submit handler
 * keeps dispatching.
 *
 * Returning `null` rather than taking a predicate is the shape the neighbouring
 * `handleNavigationCommand` / `handleProfileCommand` use, and it is what keeps
 * this file's call site to two lines — `use-submit-handler.ts` is on the size
 * ratchet, which is why the flow lives here at all.
 */
export async function handleTopicOverlayCommand(
  msg: string,
  ctx: TopicOverlayCommandContext,
): Promise<{ submitted: true } | null> {
  const input = msg.trim();
  const parts = input.split(/\s+/);
  const claimsSearch = parts[1]?.toLowerCase() === "search";
  const listView = claimedListView(parts);
  if (!claimsSearch && listView === null) return null;

  // The local-storage guard is the red line, not a nicety: the topic index lives
  // under the backend's own storage root, and `queryTopicIndex` falls back to the
  // default root (`~/.haruyuki/lc-local-backend`) when it is not handed one. A
  // backend without a root is a non-local backend, whose conversations have no
  // index at all — reading the default root there would touch the user's real
  // data for a conversation that is not even stored in it (《31》A1).
  if (!getBackend().getLocalStorageDir?.()) {
    const cmd = ctx.commandRunner.start(input, TOPIC_COMMAND_LOCAL_ONLY);
    cmd.finish(TOPIC_COMMAND_LOCAL_ONLY, true);
    return { submitted: true };
  }

  if (claimsSearch) {
    // The keyword rides the one-shot slot `/search` already uses for its own
    // initial query (`AppCoordinator`'s `searchQuery`), so this face needs no
    // state of its own and no second module-level bridge.
    ctx.setSearchQuery(parts.slice(2).join(" ").trim());
    ctx.openOverlay(
      "topic-search",
      "/topic search",
      "Opening topic search...",
      "Topic search dismissed",
    );
    return { submitted: true };
  }

  if (listView === null) return null;
  const form = LIST_FORMS[listView];
  ctx.openOverlay(form.overlay, input, form.opening, form.dismissed);
  return { submitted: true };
}
