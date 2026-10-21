// src/cli/app/pages/settings/use-settings-page.ts

import { useEffect, useRef, useState } from "react";
import type { AppViewProps } from "@/cli/app/AppView";
import type { PageActions } from "@/cli/app/pages/page-frame";
import type { PageBody, PageRow } from "@/cli/app/pages/page-model";
import {
  bucketRows,
  isRuleBucket,
  PERMISSION_BUCKET_PREFIX,
  PERMISSION_BUCKETS,
  PERMISSION_MODE_OPTIONS,
  PERMISSION_SCOPES,
  type PermissionBucket,
  permissionRows,
  rulesFor,
} from "@/cli/app/pages/settings/permissions-model";
import {
  cycleValue,
  GROUP_ROW_PREFIX,
  groupRows,
  PERMISSION_ROW_PREFIX,
  rootRows,
  SETTINGS_SECTIONS,
  type SettingsContext,
  type SettingsItem,
  type SettingsSectionId,
  validateValue,
} from "@/cli/app/pages/settings/settings-model";
import {
  SETTINGS_GROUPS,
  SETTINGS_ITEMS,
  settingItemById,
} from "@/cli/app/pages/settings/settings-schema";
import type { KeyBinding } from "@/cli/helpers/input-keys";
import {
  loadPermissions,
  removePermissionRule,
  savePermissionRule,
} from "@/permissions/loader";
import type {
  PermissionRules,
  PermissionRuleType,
  PermissionScope,
} from "@/permissions/types";

/**
 * The settings page's state machine.
 *
 * A page is one view with several screens (《38》§12.3bis: the root holds categories
 * and their entries, anything deeper is its own screen), and this hook owns the
 * three things that make that true: the **path** (which screen is up), the
 * **snapshot** (values are re-read after every write — the page never shows a value
 * it just wrote), and the **editors** (one inline text editor, one armed delete).
 *
 * Rules it keeps:
 *
 * - **A write goes through the module that owns the value.** `write` callbacks come
 *   from the schema and already end in the command-grade path; the hook only runs
 *   them and then re-reads. It assembles no settings record of its own.
 * - **The page's own feedback is not a conversation event** (§12.4 7): a change
 *   produces one transient note row, never a transcript line.
 * - **`Esc` means one screen, then the page.** A sub-screen returns to the root;
 *   the root leaves for the conversation, which is the frame's own rule.
 */
export type SettingsScreen =
  | { kind: "root" }
  | { kind: "group"; group: string }
  | { kind: "permissions" }
  | { kind: "bucket"; bucket: PermissionBucket };

export type SettingsEditorState = {
  /** Where the editor writes when it is submitted. */
  target:
    | { kind: "setting"; itemId: string }
    | { kind: "rule"; bucket: PermissionRuleType; index: number };
  label: string;
  draft: string;
  error: string | null;
};

export type SettingsPageState = {
  body: PageBody;
  actions: PageActions;
  editor: SettingsEditorState | null;
  /** The transient feedback line, drawn beside the title by the page. */
  note: string | null;
  setDraft: (draft: string) => void;
  submitEditor: () => void;
  cancelEditor: () => void;
};

/** How long a transient note stays on the page. */
const NOTE_MS = 4000;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useSettingsPage(view: AppViewProps): SettingsPageState {
  const [screen, setScreen] = useState<SettingsScreen>({ kind: "root" });
  const [version, setVersion] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [editor, setEditor] = useState<SettingsEditorState | null>(null);
  const [rules, setRules] = useState<PermissionRules | null>(null);
  const [writeScope, setWriteScope] = useState<PermissionScope>("project");
  /** The row id whose `D` has already been pressed once. */
  const armed = useRef<string | null>(null);

  const ctx: SettingsContext = {
    agentId: view.agentId,
    conversationId: view.conversationId,
    projectDirectory: view.projectDirectory,
    runtimeFlags: view.runtimeFlags,
    setRuntimeFlag: view.setRuntimeFlag,
    modelLabel: view.currentModelDisplay,
    reasoningEffort: view.currentReasoningEffort,
  };

  // The permission rules are file state, not settings-manager state: nothing else
  // invalidates them here, so the page re-reads them whenever it is up (the root
  // shows a count, and the permission screens show the rules), and again after a
  // write. `version` is the trigger, not data: it is read here so the dependency is
  // declared rather than hidden.
  useEffect(() => {
    void version;
    let cancelled = false;
    void loadPermissions(view.projectDirectory)
      .then((loaded) => {
        if (!cancelled) setRules(loaded);
      })
      .catch(() => {
        if (!cancelled) setRules(null);
      });
    return () => {
      cancelled = true;
    };
  }, [view.projectDirectory, version]);

  useEffect(() => {
    if (note === null) return;
    const timer = setTimeout(() => {
      setNote(null);
    }, NOTE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [note]);

  /** Re-read every value on the page after a write. */
  const refresh = (): void => {
    setVersion((current) => current + 1);
  };

  /** Run one write, report it in the note row, then re-read. */
  const run = async (
    label: string,
    operation: () => void | Promise<void>,
  ): Promise<void> => {
    try {
      await operation();
      refresh();
      setNote(`${label} 已更新`);
    } catch (error) {
      setNote(`${label} 失败：${messageOf(error)}`);
    }
  };

  const writeSetting = (item: SettingsItem, value: string): void => {
    if (!item.write) return;
    void run(item.label, () => item.write?.(ctx, value));
  };

  const openEditor = (
    target: SettingsEditorState["target"],
    label: string,
    value: string,
  ): void => {
    setEditor({ target, label, draft: value, error: null });
  };

  const submitEditor = (): void => {
    const current = editor;
    if (!current) return;
    const draft = current.draft.trim();

    if (current.target.kind === "setting") {
      const item = settingItemById(current.target.itemId);
      if (!item?.write) {
        setEditor(null);
        return;
      }
      const error = validateValue(item, draft);
      if (error) {
        setEditor({ ...current, error });
        return;
      }
      setEditor(null);
      writeSetting(item, draft);
      return;
    }

    if (draft === "") {
      setEditor({ ...current, error: "规则不能为空" });
      return;
    }
    const { bucket, index } = current.target;
    const previous = index >= 0 ? (rulesFor(rules, bucket)[index] ?? "") : "";
    setEditor(null);
    void run("权限规则", async () => {
      if (previous !== "") await removeFromAnyScope(bucket, previous);
      await savePermissionRule(
        draft,
        bucket,
        writeScope,
        view.projectDirectory,
      );
    });
  };

  const cancelEditor = (): void => {
    setEditor(null);
  };

  const setDraft = (draft: string): void => {
    setEditor((current) =>
      current ? { ...current, draft, error: null } : null,
    );
  };

  const goBack = (): boolean => {
    if (editor) {
      setEditor(null);
      return true;
    }
    if (screen.kind === "root") return false;
    if (screen.kind === "bucket") {
      setScreen({ kind: "permissions" });
      return true;
    }
    setScreen({ kind: "root" });
    return true;
  };

  const cycleMode = (direction: 1 | -1): void => {
    const options = PERMISSION_MODE_OPTIONS;
    const index = options.findIndex(
      (option) => option.value === view.uiPermissionMode,
    );
    const start = index < 0 ? 0 : index;
    const next = options[(start + direction + options.length) % options.length];
    if (!next) return;
    // The composer's own handler: it also syncs the singleton the permission
    // checks read, which is what `Shift+Tab` goes through (§12.6 2).
    view.handlePermissionModeChange(next.value);
    setNote(`权限模式 → ${next.value}`);
  };

  const cycleWriteScope = (direction: 1 | -1): void => {
    const index = PERMISSION_SCOPES.indexOf(writeScope);
    const start = index < 0 ? 0 : index;
    const next =
      PERMISSION_SCOPES[
        (start + direction + PERMISSION_SCOPES.length) %
          PERMISSION_SCOPES.length
      ];
    if (!next) return;
    setWriteScope(next);
    setNote(`权限规则写入 → ${next}`);
  };

  const openRuleEditor = (row: PageRow): void => {
    if (row.kind !== "item") return;
    if (screen.kind !== "bucket" || !isRuleBucket(screen.bucket)) return;
    const index = Number(row.id.slice(row.id.lastIndexOf(":") + 1));
    const rule = rulesFor(rules, screen.bucket)[index];
    if (rule === undefined) return;
    openEditor(
      { kind: "rule", bucket: screen.bucket, index },
      screen.bucket,
      rule,
    );
  };

  /** Remove a rule from whichever scope file holds it. */
  const removeFromAnyScope = async (
    bucket: PermissionRuleType,
    rule: string,
  ): Promise<boolean> => {
    // The list on screen is merged from three files, so the write scope is not
    // necessarily the one holding the rule. The write scope is tried first, then
    // the rest in precedence order; the answer says whether anything went.
    const scopes: PermissionScope[] = [writeScope, ...PERMISSION_SCOPES];
    const tried = new Set<PermissionScope>();
    for (const scope of scopes) {
      if (tried.has(scope)) continue;
      tried.add(scope);
      if (
        await removePermissionRule(rule, bucket, scope, view.projectDirectory)
      ) {
        return true;
      }
    }
    return false;
  };

  const activate = (row: PageRow): void => {
    if (row.kind !== "item") return;
    armed.current = null;

    if (row.id.startsWith(GROUP_ROW_PREFIX)) {
      setScreen({
        kind: "group",
        group: row.id.slice(GROUP_ROW_PREFIX.length),
      });
      return;
    }
    if (row.id === `${PERMISSION_ROW_PREFIX}permission`) {
      setScreen({ kind: "permissions" });
      return;
    }
    if (row.id.startsWith(PERMISSION_BUCKET_PREFIX)) {
      const bucket = row.id.slice(
        PERMISSION_BUCKET_PREFIX.length,
      ) as PermissionBucket;
      if (PERMISSION_BUCKETS.find((entry) => entry.id === bucket)?.writable) {
        setScreen({ kind: "bucket", bucket });
      }
      return;
    }
    if (row.id === `${PERMISSION_ROW_PREFIX}mode`) {
      cycleMode(1);
      return;
    }
    if (row.id === `${PERMISSION_ROW_PREFIX}scope`) {
      cycleWriteScope(1);
      return;
    }
    if (row.id.startsWith("perm:rule:")) {
      openRuleEditor(row);
      return;
    }

    const item = settingItemById(row.id);
    if (!item?.editable) return;
    if (item.kind === "toggle") {
      writeSetting(item, item.read(ctx) === "true" ? "false" : "true");
      return;
    }
    if (item.kind === "select") {
      const next = cycleValue({
        item,
        raw: item.read(ctx) ?? "",
        direction: 1,
      });
      if (next !== null) writeSetting(item, next);
      return;
    }
    openEditor(
      { kind: "setting", itemId: item.id },
      item.label,
      item.read(ctx) ?? "",
    );
  };

  const toggle = (row: PageRow): void => {
    if (row.kind !== "item") return;
    const item = settingItemById(row.id);
    if (!item?.editable || item.kind !== "toggle") return;
    writeSetting(item, item.read(ctx) === "true" ? "false" : "true");
  };

  const adjust = (row: PageRow, direction: 1 | -1): boolean => {
    if (row.kind !== "item") return false;
    if (row.id === `${PERMISSION_ROW_PREFIX}mode`) {
      cycleMode(direction);
      return true;
    }
    if (row.id === `${PERMISSION_ROW_PREFIX}scope`) {
      cycleWriteScope(direction);
      return true;
    }
    const item = settingItemById(row.id);
    if (!item?.editable) return false;
    if (item.kind !== "select" && item.kind !== "number") return false;
    const next = cycleValue({ item, raw: item.read(ctx) ?? "", direction });
    if (next === null) return false;
    writeSetting(item, next);
    return true;
  };

  /**
   * The bucket screen's own keys.
   *
   * A function of the cursor row, and the frame calls it during the render that
   * moves the cursor: `D` deletes *that* row, and the armed row id means a `D`
   * after a move arms the new row instead of deleting the old one. It is a plain
   * function on purpose — the table is rebuilt every render and handed to the
   * router through the frame's ref, so memoising it would only freeze last
   * render's rows.
   */
  const bindings = (cursorRow: PageRow | undefined): readonly KeyBinding[] => {
    if (screen.kind !== "bucket" || !isRuleBucket(screen.bucket)) return [];
    const bucket = screen.bucket;
    return [
      {
        id: "settings.rule.add",
        chords: [{ key: "a" }],
        label: "新增规则",
        run: () => {
          openEditor({ kind: "rule", bucket, index: -1 }, `${bucket} 新增`, "");
          return "consumed";
        },
      },
      {
        id: "settings.rule.delete",
        chords: [{ key: "d" }],
        label: "删除规则",
        run: () => {
          if (!cursorRow || cursorRow.kind !== "item") return "declined";
          if (armed.current !== cursorRow.id) {
            armed.current = cursorRow.id;
            setNote(`再按 D 删除：${cursorRow.label}`);
            return "consumed";
          }
          armed.current = null;
          const rule = cursorRow.label;
          void run("权限规则", async () => {
            const removed = await removeFromAnyScope(bucket, rule);
            if (!removed) throw new Error("没找到这条规则");
          });
          return "consumed";
        },
      },
    ];
  };

  return {
    body: buildBody({
      screen,
      ctx,
      rules,
      writeScope,
      permissionModeLabel: view.uiPermissionMode,
    }),
    actions: { activate, toggle, adjust, back: goBack, bindings },
    editor,
    note,
    setDraft,
    submitEditor,
    cancelEditor,
  };
}

/** Everything the frame draws, from the current screen and values. */
function buildBody(input: {
  screen: SettingsScreen;
  ctx: SettingsContext;
  rules: PermissionRules | null;
  writeScope: PermissionScope;
  permissionModeLabel: string;
}): PageBody {
  const { screen, ctx } = input;

  let body: PageBody;
  if (screen.kind === "group") {
    const group = SETTINGS_GROUPS.find((entry) => entry.id === screen.group);
    body = {
      title: "Settings",
      breadcrumb: [
        "Settings",
        sectionLabelOf(group?.section),
        group?.label ?? screen.group,
      ],
      screen: `group:${screen.group}`,
      rows: groupRows(SETTINGS_ITEMS, screen.group, ctx),
    };
  } else if (screen.kind === "permissions") {
    body = {
      title: "Settings",
      breadcrumb: ["Settings", "工具与权限", "权限"],
      screen: "permissions",
      rows: permissionRows({
        rules: input.rules,
        mode: input.permissionModeLabel,
        writeScope: input.writeScope,
      }),
    };
  } else if (screen.kind === "bucket") {
    const bucket = PERMISSION_BUCKETS.find(
      (entry) => entry.id === screen.bucket,
    );
    body = {
      title: "Settings",
      breadcrumb: [
        "Settings",
        "工具与权限",
        "权限",
        bucket?.label ?? screen.bucket,
      ],
      screen: `bucket:${screen.bucket}`,
      rows: bucketRows({ rules: input.rules, bucket: screen.bucket }),
    };
  } else {
    body = {
      title: "Settings",
      screen: "root",
      rows: rootRows({
        sections: SETTINGS_SECTIONS,
        items: SETTINGS_ITEMS,
        groups: SETTINGS_GROUPS,
        ctx,
        permissionRuleCount: permissionRuleCount(input.rules),
      }),
    };
  }

  return body;
}

function sectionLabelOf(section: SettingsSectionId | undefined): string {
  if (section === undefined) return "Settings";
  return (
    SETTINGS_SECTIONS.find((entry) => entry.id === section)?.label ?? "Settings"
  );
}

/** How many rules the merged permission set carries, for the root's `权限` row. */
function permissionRuleCount(
  rules: PermissionRules | null,
): number | undefined {
  if (!rules) return undefined;
  return (
    (rules.allow?.length ?? 0) +
    (rules.deny?.length ?? 0) +
    (rules.ask?.length ?? 0) +
    (rules.alwaysAsk?.length ?? 0) +
    (rules.additionalDirectories?.length ?? 0)
  );
}
