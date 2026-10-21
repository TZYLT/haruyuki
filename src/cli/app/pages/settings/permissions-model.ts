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
  { id: "allow", label: "允许", writable: true },
  { id: "deny", label: "拒绝", writable: true },
  { id: "ask", label: "询问", writable: true },
  { id: "alwaysAsk", label: "总是询问", writable: true },
  {
    id: "additionalDirectories",
    label: "附加目录",
    writable: false,
    reason: "无写入路径（改 settings.json）",
  },
];

export const PERMISSION_MODE_OPTIONS = [
  { value: "unrestricted", label: "unrestricted（全放行）" },
  { value: "standard", label: "standard（按规则）" },
  { value: "acceptEdits", label: "acceptEdits（编辑放行）" },
  { value: "strict", label: "strict（全部询问）" },
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
 * `Settings / 工具与权限 / 权限`: the mode, the buckets and the write scope.
 *
 * `mode` carries `[会话]` because it is session state: `permissionMode.setMode`
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
      label: "模式",
      value:
        PERMISSION_MODE_OPTIONS.find((option) => option.value === input.mode)
          ?.label ?? input.mode,
      key: "←→",
      hint: "[会话]",
    },
  ];

  for (const bucket of PERMISSION_BUCKETS) {
    const count = rulesFor(input.rules, bucket.id).length;
    rows.push({
      kind: "item",
      id: `${PERMISSION_BUCKET_PREFIX}${bucket.id}`,
      label: bucket.label,
      value: `${count} 条`,
      key: bucket.writable ? "▸" : undefined,
      hint: bucket.writable ? undefined : bucket.reason,
      disabled: !bucket.writable,
    });
  }

  rows.push(
    {
      kind: "item",
      id: `${PERMISSION_ROW_PREFIX}scope`,
      label: "写入",
      value: input.writeScope,
      key: "←→",
      hint: "[三级]",
    },
    {
      kind: "note",
      text: "A 新增 · Enter 编辑 · D 删除（再按一次确认）· Esc 返回",
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
        text: "（空）A 新增一条 · Esc 返回",
      },
    ];
  }
  return rules.map((rule, index) => ({
    kind: "item",
    id: ruleRowId(input.bucket, index),
    label: rule,
  }));
}
