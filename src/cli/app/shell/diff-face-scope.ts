import { createContext, useContext } from "react";

/**
 * Whether this tree's shell can raise the full-screen diff face (M6-P8).
 *
 * The face is mounted by the full-screen shell, which chooses the band's content
 * (`V2Shell`); the append shell has no band to take and no overlay route to raise,
 * so a key that opened it there would disable the composer with nothing on screen —
 * a frozen input, which is the worst shape a compatibility-mode regression can take.
 *
 * A context rather than a prop for the same reason as the rail's
 * (`sidebar-scope.ts`): whether a face exists is a **shell** fact, and
 * `AppViewProps` is the core's projection. The full-screen shell provides `true`;
 * the append shell provides nothing, every consumer reads the default `false`, and
 * its tree is byte-for-byte what it was.
 */
export const DiffFaceScope = createContext(false);

/** True while the shell that mounted this tree can raise the diff face. */
export function useHasDiffFace(): boolean {
  return useContext(DiffFaceScope);
}
