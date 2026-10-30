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
  | "DreamAuthorization";

export const DREAM_TOOL_NAMES: readonly DreamToolName[] = [
  "MemoryCommit",
  "DreamStatus",
  "DreamDone",
  "DreamAuthorization",
];

export function isDreamToolName(value: unknown): value is DreamToolName {
  return (
    typeof value === "string" &&
    (DREAM_TOOL_NAMES as readonly string[]).includes(value)
  );
}
