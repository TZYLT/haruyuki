/**
 * The `/recall config` key vocabulary (48-4 D-05/D-16).
 *
 * The list lives in its own leaf module rather than beside the parser because
 * two consumers need it and only one of them may import the parser's host:
 * completion renders these keys as the `config` row's children
 * (`subcommand-specs.ts`), and reaching them through `recall.ts` would pull the
 * store, the backend and the transcript display into the composer's completion
 * resolver. The parser imports the same list, so the keys the popup offers and
 * the keys the parser accepts are one list rather than two copies that drift.
 */

/** Every key `/recall config` accepts (48-4 D-05/D-16). */
export type RecallConfigKey =
  | "timeout"
  | "dedup"
  | "limit"
  | "excerpt"
  | "chars"
  | "ratio"
  | "diversity"
  | "display"
  | "weight"
  | "depth";

export const RECALL_CONFIG_KEYS: readonly RecallConfigKey[] = [
  "timeout",
  "dedup",
  "limit",
  "excerpt",
  "chars",
  "ratio",
  "diversity",
  "display",
  "weight",
  "depth",
];

export function isRecallConfigKey(
  value: string | undefined,
): value is RecallConfigKey {
  return (
    value !== undefined &&
    (RECALL_CONFIG_KEYS as readonly string[]).includes(value)
  );
}
