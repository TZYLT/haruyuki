/**
 * The dream tool family (F-06, route §2.3 M0 freeze).
 *
 * The names are frozen here so the declaration gate, the permission checker and
 * the prompts agree on them. Only `MemoryCommit` is implemented at M0; the rest
 * arrive with M3, and the declaration gate adds whichever names exist in
 * `TOOL_DEFINITIONS`, so no second list has to be kept in sync.
 */
export type DreamToolName =
  | "MemoryCommit"
  | "DreamStatus"
  | "DreamDone"
  | "DreamAuthorization"
  | "DreamNote";

export const DREAM_TOOL_NAMES: readonly DreamToolName[] = [
  "MemoryCommit",
  "DreamStatus",
  "DreamDone",
  "DreamAuthorization",
  "DreamNote",
];

/**
 * Ordinary tools the dream prompts require (R-5.4.3), added to the declaration
 * alongside the dream family.
 *
 * The run reuses the agent's stable toolset, but a model-derived preset may not
 * carry them: the `codex` preset has no `Read`/`Write`/`Edit`/`Glob`/`Grep`
 * (its shell tool is also disabled for dream runs), and the `none` preset is
 * empty. A dream prompt that says "read the memory files" must not advertise a
 * toolset that cannot do it, so the scope resolver adds these names explicitly.
 * Every name is filtered against `TOOL_DEFINITIONS` before it reaches `include`.
 */
export const DREAM_REQUIRED_TOOL_NAMES: readonly string[] = [
  "TopicQuery",
  "SessionRead",
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
];

export function isDreamToolName(value: unknown): value is DreamToolName {
  return (
    typeof value === "string" &&
    (DREAM_TOOL_NAMES as readonly string[]).includes(value)
  );
}
