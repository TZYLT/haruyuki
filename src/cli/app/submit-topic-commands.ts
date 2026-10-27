/**
 * `/topic list --all` and `/topic search <kw>` — the two topic faces that must
 * open an overlay, which a registry handler cannot do (route C-23).
 *
 * A registry handler returns a string; `AppView` mounts a face. So the submit
 * layer is where these two commands are claimed, exactly as `/search` is: the
 * registry entry stays as the answer for the channels that have no terminal
 * (listener, headless), and the TUI intercepts before it.
 *
 * The other half of the job is *not* claiming too much. The registry's `/topic`
 * entry treats its first word as a title, so before this branch existed
 * `/topic search deploy` recorded a marker called "search" (C-22). The dispatch
 * now knows the three subcommands, and this module claims only the two that need
 * a face; `/topic list`, `/topic list help`, `/topic <title>` and every refusal
 * still reach the registry.
 */
import type { Dispatch, SetStateAction } from "react";
import { getBackend } from "@/backend";
import type { CommandHandle } from "@/cli/commands/runner";
import { TOPIC_COMMAND_LOCAL_ONLY } from "@/cli/commands/topic";
import type { ActiveOverlay, AppCommandRunner } from "./types";

/**
 * What these two commands need from the submit environment.
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
  const subcommand = parts[1]?.toLowerCase();
  const claimsSearch = subcommand === "search";
  // `--all` alone. Anything else after `list` belongs to the registry, which
  // rejects an unknown option by name; claiming it here would swallow that.
  const claimsAll =
    subcommand === "list" && parts.length === 3 && parts[2] === "--all";
  if (!claimsSearch && !claimsAll) return null;

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

  ctx.openOverlay(
    "topic-list",
    "/topic list --all",
    "Opening the topic list...",
    "Topic list dismissed",
  );
  return { submitted: true };
}
