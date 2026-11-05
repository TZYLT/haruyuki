// src/cli/helpers/settings-deep-link.ts

/**
 * Settings deep links (48-2 O-05, §4.9; D3 item 6).
 *
 * The settings page is a full-screen TUI page, so a command that wants to show
 * one value cannot raise a specific row on every shell: the legacy Ink shell and
 * headless mode have no pages at all. This module is the pure decision layer
 * between the two:
 *
 * - `resolveSettingsDeepLink({ target, host })` either returns the **target** the
 *   shell should raise (TUI) or `null` plus the **`set` command** to print/run
 *   (legacy TUI, headless) — the O-05 fallback.
 * - The command spellings are table data, not branches, so aligning them with
 *   D4's `/recall embedding …` implementations is a one-table edit.
 *
 * Nothing here touches React, settings or the terminal: it is a pure function
 * pair plus two tables, which is what makes the host matrix testable.
 */

/** How the host can present a setting. */
export type SettingsHost = "tui" | "legacy" | "headless";

/** A host that has to fall back to a command (everything but the page). */
export type SettingsFallbackHost = Exclude<SettingsHost, "tui">;

/** Where a deep link lands: the settings page, a group, optionally one row. */
export interface SettingsDeepLinkTarget {
  readonly page: "settings";
  readonly group: string;
  readonly item?: string;
}

/** The decision for one host: raise the page, or print the command instead. */
export interface SettingsDeepLinkPlan {
  /** Non-null only when this host can draw the settings page. */
  readonly target: SettingsDeepLinkTarget | null;
  /** The `set` command that changes the same value; used when `target` is null. */
  readonly fallback: string | null;
}

/** The URL-ish scheme deep links are written as (`settings/<group>/<item>`). */
export const SETTINGS_DEEP_LINK_SCHEME = "settings";

/** The settings-page group that owns feature ③'s rows. */
export const EMBEDDING_SETTINGS_GROUP_ID = "embedding";

/** The embedding group's deep link, optionally to one schema row. */
export function embeddingSettingsDeepLink(
  item?: string,
): SettingsDeepLinkTarget {
  return item === undefined
    ? { page: "settings", group: EMBEDDING_SETTINGS_GROUP_ID }
    : { page: "settings", group: EMBEDDING_SETTINGS_GROUP_ID, item };
}

/** `settings/embedding/recallEmbeddingWeight`; the inverse of the parser. */
export function formatSettingsDeepLink(target: SettingsDeepLinkTarget): string {
  const segments = [
    SETTINGS_DEEP_LINK_SCHEME,
    target.group,
    ...(target.item === undefined ? [] : [target.item]),
  ];
  return segments.join("/");
}

/**
 * Parse a deep link path. Unknown schemes, an empty group and extra segments are
 * `null` rather than a partial guess: a link the page cannot honour must not
 * silently land on the root screen.
 */
export function parseSettingsDeepLinkPath(
  path: string,
): SettingsDeepLinkTarget | null {
  const [scheme, group, item, ...rest] = path
    .trim()
    .split("/")
    .filter((segment) => segment.length > 0);
  if (scheme !== SETTINGS_DEEP_LINK_SCHEME || group === undefined) return null;
  if (rest.length > 0) return null;
  return item === undefined
    ? { page: "settings", group }
    : { page: "settings", group, item };
}

/** One command spelling per host. `tui` is the slash command, `cli` the binary. */
interface SetCommandForm {
  readonly legacy: string;
  readonly headless: string;
}

/**
 * The `set` command for each embedding row (O-05).
 *
 * The knob spellings follow `/recall`'s existing `set` shape (`/recall limit
 * 250`): `/recall embedding <knob> <value>`. Endpoint shape changes go through
 * `setup`, because an endpoint is only accepted after a successful test embed
 * (48-1 §7.2) and no one-line setter can prove that.
 */
const EMBEDDING_SET_COMMANDS: Readonly<Record<string, SetCommandForm>> = {
  recallEmbeddingEnabled: {
    legacy: "/recall embedding on|off",
    headless: "haruyuki recall embedding on|off",
  },
  recallEmbeddingBackend: {
    legacy: "/recall embedding connect",
    headless: "haruyuki recall embedding connect",
  },
  recallEmbeddingModel: {
    legacy: "/recall embedding connect",
    headless: "haruyuki recall embedding connect",
  },
  recallEmbeddingEndpoint: {
    legacy: "/recall embedding connect",
    headless: "haruyuki recall embedding connect",
  },
  recallEmbeddingApiKey: {
    legacy: "/recall embedding connect",
    headless: "haruyuki recall embedding connect",
  },
  recallEmbeddingWeight: {
    legacy: "/recall config weight <0..1>",
    headless: "haruyuki recall config weight <0..1>",
  },
  recallEmbeddingCandidateDepth: {
    legacy: "/recall config depth <n>",
    headless: "haruyuki recall config depth <n>",
  },
  recallEmbeddingChunkTarget: {
    legacy: "/recall embedding config chunk-target <tokens>",
    headless: "haruyuki recall embedding config chunk-target <tokens>",
  },
  recallEmbeddingChunkMax: {
    legacy: "/recall embedding config chunk-max <tokens>",
    headless: "haruyuki recall embedding config chunk-max <tokens>",
  },
  recallEmbeddingChunkOverlap: {
    legacy: "/recall embedding config chunk-overlap <tokens>",
    headless: "haruyuki recall embedding config chunk-overlap <tokens>",
  },
  recallEmbeddingMaxChunksPerMessage: {
    legacy: "/recall embedding config max-chunks <n>",
    headless: "haruyuki recall embedding config max-chunks <n>",
  },
  recallEmbeddingThreads: {
    legacy: "/recall embedding config threads <n>",
    headless: "haruyuki recall embedding config threads <n>",
  },
  recallEmbeddingGpu: {
    legacy: "/recall embedding config gpu auto|off",
    headless: "haruyuki recall embedding config gpu auto|off",
  },
  recallEmbeddingQuantization: {
    legacy: "/recall embedding connect",
    headless: "haruyuki recall embedding connect",
  },
  recallEmbeddingKeepSpaces: {
    legacy: "/recall embedding model",
    headless: "haruyuki recall embedding model --json",
  },
};

const EMBEDDING_GROUP_COMMAND: SetCommandForm = {
  legacy: "/recall embedding",
  headless: "haruyuki recall embedding status",
};

/**
 * The `set` command that changes one embedding row without the settings page.
 * `item` undefined addresses the whole group; an unknown row falls back to the
 * group command rather than inventing a setter.
 */
export function embeddingSetCommand(
  item: string | undefined,
  host: SettingsFallbackHost,
): string {
  if (item === undefined) return EMBEDDING_GROUP_COMMAND[host];
  return EMBEDDING_SET_COMMANDS[item]?.[host] ?? EMBEDDING_GROUP_COMMAND[host];
}

/**
 * Decide what a deep link means for this host.
 *
 * The TUI gets the page target; legacy and headless get `null` and the command
 * that sets the same value (O-05). A group this module has no command for stays
 * `null`/`null` — the caller must say "the settings page is not available here"
 * rather than advertise a command that does not exist.
 */
export function resolveSettingsDeepLink(input: {
  readonly target: SettingsDeepLinkTarget;
  readonly host: SettingsHost;
}): SettingsDeepLinkPlan {
  if (input.host === "tui") return { target: input.target, fallback: null };
  const fallback =
    input.target.group === EMBEDDING_SETTINGS_GROUP_ID
      ? embeddingSetCommand(input.target.item, input.host)
      : null;
  return { target: null, fallback };
}
