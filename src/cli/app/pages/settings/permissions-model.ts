// src/cli/app/pages/settings/permissions-model.ts

import type { PageRow } from "@/cli/app/pages/page-model";
import { PERMISSION_ROW_PREFIX } from "@/cli/app/pages/settings/settings-model";
import type {
  PermissionRules,
  PermissionRuleType,
  PermissionScope,
} from "@/permissions/types";

/**
 * The permission editor's screens, as rows.
 *
 * 《38》§12.5 found this to be the one domain with no dedicated UI anywhere in
 * `src/cli` (`PermissionRules` had zero hits), which is why it is the only new
 * editing capability the settings page adds; everything else reuses a command's
 * writer. The shapes below are the spec's §12.6 frame: a mode row, one row per
 * bucket with its count, the persistent write-scope row, and a rule list one
 * level down.
 *
 * Pure on purpose: the rules are read from disk by the page (they are file state,
 * not settings-manager state), and everything here is a function of that value, so
 * the screen can be asserted without a filesystem.
 */
export type PermissionBucket =
  | "allow"
  | "deny"
  | "ask"
  | "alwaysAsk"
  | "additionalDirectories";

export type BucketDefinition = {
  id: PermissionBucket;
  label: string;
  /** Whether this page can edit the bucket; `false` carries the reason instead. */
  writable: boolean;
  reason?: string;
};

/**
 * The five buckets, in the spec's order.
 *
 * `additionalDirectories` is read-only and says why: no writer in this tree writes
 * it (`savePermissionRule` only touches the four rule lists), so a bucket the page
 * could open for editing but could never save would be a lie.
 */
export const PERMISSION_BUCKETS: readonly BucketDefinition[] = [
  { id: "allow", label: "Allow", writable: true },
  { id: "deny", label: "Deny", writable: true },
  { id: "ask", label: "Ask", writable: true },
  { id: "alwaysAsk", label: "Always ask", writable: true },
  {
    id: "additionalDirectories",
    label: "Extra directories",
    writable: false,
    reason: "No write path (edit settings.json)",
  },
];

export const PERMISSION_MODE_OPTIONS = [
  { value: "unrestricted", label: "unrestricted (allow all)" },
  { value: "standard", label: "standard (by rules)" },
  { value: "acceptEdits", label: "acceptEdits (edits allowed)" },
  { value: "strict", label: "strict (ask for all)" },
] as const;

/** The scopes a rule can be written to, in the order `←→` cycles them. */
export const PERMISSION_SCOPES: readonly PermissionScope[] = [
  "project",
  "local",
  "user",
];

export const PERMISSION_BUCKET_PREFIX = "perm:bucket:";
export const PERMISSION_RULE_PREFIX = "perm:rule:";

/** A row id for a rule; the index is inside the bucket screen only. */
export function ruleRowId(bucket: PermissionBucket, index: number): string {
  return `${PERMISSION_RULE_PREFIX}${bucket}:${index}`;
}

/** The rules of one bucket, always an array. */
export function rulesFor(
  rules: PermissionRules | null,
  bucket: PermissionBucket,
): string[] {
  return rules?.[bucket] ?? [];
}

/** The `PermissionRuleType` a bucket writes to, for the four rule lists. */
export function ruleTypeOf(
  bucket: PermissionBucket,
): PermissionRuleType | null {
  return bucket === "additionalDirectories" ? null : bucket;
}

/** Only these buckets are edited through the rule writer. */
export function isRuleBucket(
  bucket: PermissionBucket,
): bucket is PermissionRuleType {
  return bucket !== "additionalDirectories";
}

/**
 * `Settings / Tools & permissions / Permissions`: the mode, the buckets and the write scope.
 *
 * `mode` carries `[Session]` because it is session state: `permissionMode.setMode`
 * changes the running process and nothing on disk (§12.6 2 — the same value
 * `Shift+Tab` cycles). The write scope row is the page's only three-level write
 * and it is drawn permanently, as the spec demands.
 */
export function permissionRows(input: {
  rules: PermissionRules | null;
  mode: string;
  writeScope: PermissionScope;
}): PageRow[] {
  const rows: PageRow[] = [
    {
      kind: "item",
      id: `${PERMISSION_ROW_PREFIX}mode`,
      label: "Mode",
      value:
        PERMISSION_MODE_OPTIONS.find((option) => option.value === input.mode)
          ?.label ?? input.mode,
      hint: "[session]",
    },
  ];

  for (const bucket of PERMISSION_BUCKETS) {
    const count = rulesFor(input.rules, bucket.id).length;
    const countLabel = `${count} ${count === 1 ? "rule" : "rules"}`;
    rows.push({
      kind: "item",
      id: `${PERMISSION_BUCKET_PREFIX}${bucket.id}`,
      label: bucket.label,
      // A bucket with no writer carries its reason where the value is, the same
      // shape a read-only scalar uses, instead of hiding it in a 16-cell column.
      value: bucket.writable
        ? countLabel
        : `${countLabel} · ${bucket.reason ?? ""}`,
      key: bucket.writable ? "▸" : undefined,
      disabled: !bucket.writable,
    });
  }

  rows.push(
    {
      kind: "item",
      id: `${PERMISSION_ROW_PREFIX}scope`,
      label: "Write to",
      value: input.writeScope,
      hint: "[three-level]",
    },
    {
      kind: "note",
      text: "A add · Enter edit · D delete (again confirms) · Esc back",
    },
  );
  return rows;
}

/**
 * One bucket's rules: a list of strings, which is all a rule is.
 *
 * An empty bucket says so instead of drawing a blank screen — the cursor has
 * nowhere to be there, and a screen with no rows and no explanation looks broken.
 */
export function bucketRows(input: {
  rules: PermissionRules | null;
  bucket: PermissionBucket;
}): PageRow[] {
  const rules = rulesFor(input.rules, input.bucket);
  if (rules.length === 0) {
    return [
      {
        kind: "note",
        text: "(empty) A to add · Esc back",
      },
    ];
  }
  return rules.map((rule, index) => ({
    kind: "item",
    id: ruleRowId(input.bucket, index),
    label: rule,
  }));
}
