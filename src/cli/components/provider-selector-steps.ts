import type { AuthMethod, ByokProvider } from "@/providers/byok-providers";

/**
 * `/connect`'s steps, and what each one renders from.
 *
 * The overlay is a wizard's trail of step names plus **one** payload: the
 * provider the current step is about, and the auth method the multi-field step
 * was opened with. One payload is enough because every step below the list is a
 * view of the provider the user just picked — the trail is what remembers the
 * path, which is why the conditional escapes the hand-written ladder had
 * (`/connect`'s multi-field step returns to the method picker only when it was
 * the picker that opened it) are gone: the path *is* what was taken.
 *
 * Kept out of the component so the state a step renders from is a value with a
 * name, and so the face is about its handlers rather than its union.
 */

/** The steps this overlay can be on, in the order a person meets them. */
export type ConnectStep =
  | "list"
  | "input"
  | "multiInput"
  | "methodSelect"
  | "profileSelect"
  | "options"
  | "oauthNameInput";

/** The shape a step renders from. `type` is the step it belongs to. */
export type ConnectViewState =
  | { type: "list" }
  | { type: "input"; provider: ByokProvider }
  | { type: "multiInput"; provider: ByokProvider; authMethod?: AuthMethod }
  | { type: "methodSelect"; provider: ByokProvider }
  | { type: "profileSelect"; provider: ByokProvider }
  | { type: "options"; provider: ByokProvider }
  | { type: "oauthNameInput"; provider: ByokProvider };

/**
 * What every step below the list is about. `null` before a provider has been
 * picked; `viewFor` is total over that, so a step that somehow has no provider
 * renders the list — the safe thing to paint, and the same guard the renderers
 * used to carry each on their own.
 */
export interface ConnectSubject {
  provider: ByokProvider;
  authMethod: AuthMethod | null;
}

export function viewFor(
  step: ConnectStep,
  subject: ConnectSubject | null,
): ConnectViewState {
  if (step === "list" || !subject) return { type: "list" };
  const { provider, authMethod } = subject;
  switch (step) {
    case "input":
      return { type: "input", provider };
    case "methodSelect":
      return { type: "methodSelect", provider };
    case "profileSelect":
      return { type: "profileSelect", provider };
    case "multiInput":
      return {
        type: "multiInput",
        provider,
        authMethod: authMethod ?? undefined,
      };
    case "options":
      return { type: "options", provider };
    case "oauthNameInput":
      return { type: "oauthNameInput", provider };
  }
}
