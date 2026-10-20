// src/cli/app/shell/sidebar-scope.ts

import { createContext, useContext } from "react";

/**
 * Whether the band in this tree has a rail beside it (`《38》§6`).
 *
 * A **shell** fact that the band has to know, and a context rather than a prop
 * for one reason: `AppViewProps` is the core's projection, and whether a rail is
 * drawn is not something the core has an opinion about. Threading a boolean
 * through it would put a shell concept in the type every conversation-state
 * projection must satisfy — and `AppView.tsx` is at its file-size ceiling, so the
 * type cannot grow a documented field anyway.
 *
 * The full-screen shell provides `true`; the append shell provides nothing, so
 * every consumer reads the default `false` and its tree is unchanged. That is the
 * same shape as `transcript` (a shell decision that never becomes a mode branch),
 * with the difference that the value is read three levels down.
 */
export const ContextSidebarScope = createContext(false);

/** True while the shell that mounted this tree draws a rail. */
export function useHasContextSidebar(): boolean {
  return useContext(ContextSidebarScope);
}
