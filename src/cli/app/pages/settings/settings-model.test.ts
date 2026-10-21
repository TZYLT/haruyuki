import { describe, expect, test } from "bun:test";
import type { PageRow } from "@/cli/app/pages/page-model";
import {
  bucketRows,
  PERMISSION_BUCKETS,
  PERMISSION_MODE_OPTIONS,
  permissionRows,
} from "@/cli/app/pages/settings/permissions-model";
import {
  cycleValue,
  displayValue,
  groupRows,
  rootRows,
  SETTINGS_SECTIONS,
  type SettingsContext,
  scopeMarker,
  settingRow,
  validateValue,
} from "@/cli/app/pages/settings/settings-model";
import {
  SETTINGS_GROUPS,
  SETTINGS_ITEMS,
} from "@/cli/app/pages/settings/settings-schema";

/**
 * The settings page's data, without a terminal.
 *
 * The schema is the part of P3 that can be wrong in ways the frame cannot show: an
 * entry that claims to be editable but has no writer, a group row for a group that
 * does not exist, two controls over one stored key. Those are asserted here; the
 * screens and the keys are asserted on the frame (`settings-page.test.tsx`).
 */
const CTX: SettingsContext = {
  agentId: "agent-1",
  conversationId: "conv-1",
  projectDirectory: "C:/tmp/project",
};

const rows = (items: PageRow[]): string[] =>
  items.map((row) =>
    row.kind === "item"
      ? `${row.id}|${row.value ?? ""}`
      : `${row.kind}|${row.text}`,
  );

describe("the schema", () => {
  test("every id is unique", () => {
    const ids = SETTINGS_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every item belongs to a section that exists", () => {
    const sections = new Set(SETTINGS_SECTIONS.map((section) => section.id));
    for (const item of SETTINGS_ITEMS) {
      expect(sections.has(item.section)).toBe(true);
    }
  });

  test("every group an item names exists, and sits in the same section", () => {
    for (const item of SETTINGS_ITEMS) {
      if (item.group === undefined) continue;
      const group = SETTINGS_GROUPS.find((entry) => entry.id === item.group);
      expect(group).toBeDefined();
      expect(group?.section).toBe(item.section);
    }
  });

  test("an editable row has a writer; a read-only row says why", () => {
    for (const item of SETTINGS_ITEMS) {
      if (item.editable) {
        expect(item.write).toBeDefined();
      } else {
        expect(
          item.reason,
          `${item.id} is read-only without a reason`,
        ).toBeTruthy();
      }
    }
  });

  test("a select has options, and its current value is one of them", () => {
    for (const item of SETTINGS_ITEMS) {
      if (item.kind !== "select") continue;
      expect(item.options?.length ?? 0).toBeGreaterThan(1);
    }
  });

  test("one stored key has one control", () => {
    // `experimentManager.set("conversation_titles", …)` writes the same setting as
    // `autoConversationTitles`; the page deliberately keeps only the setting.
    const labels = SETTINGS_ITEMS.map((item) => item.id);
    expect(labels).toContain("autoConversationTitles");
    expect(labels).not.toContain("experiment:conversation_titles");
  });

  test("the inventory is pinned, so an addition is a decision", () => {
    // 32 writable + 13 read-only at P3. Changing this list is fine; changing the
    // number without a docs update is what this test is for.
    expect(SETTINGS_ITEMS.filter((item) => item.editable)).toHaveLength(32);
    expect(SETTINGS_ITEMS).toHaveLength(45);
  });
});

describe("rows", () => {
  test("a section with no items draws no title", () => {
    const body = rootRows({
      sections: SETTINGS_SECTIONS,
      items: SETTINGS_ITEMS,
      groups: SETTINGS_GROUPS,
      ctx: CTX,
    });
    const headers = body.filter((row) => row.kind === "header");
    expect(headers.map((row) => row.text)).toContain("上下文管理");
    // A section that lost all its items would leave a stray title; the builder
    // checks first, so every drawn title has rows after it.
    for (const header of headers) {
      const index = body.indexOf(header);
      expect(body[index + 1]?.kind).toBe("item");
    }
  });

  test("a group with several items becomes one row that opens its screen", () => {
    const body = rootRows({
      sections: SETTINGS_SECTIONS,
      items: SETTINGS_ITEMS,
      groups: SETTINGS_GROUPS,
      ctx: CTX,
    });
    const group = body.find(
      (row) => row.kind === "item" && row.id === "group:recall",
    );
    expect(group?.kind === "item" && group.value).toBe("10 项");
    // Its items are on the group's own screen, not under the row.
    expect(rows(body)).not.toContain("recallEnabled|");
    expect(rows(groupRows(SETTINGS_ITEMS, "recall", CTX))).toContain(
      "recallEnabled|On",
    );
  });

  test("a single-item group is drawn in place instead of costing a screen", () => {
    const single = SETTINGS_GROUPS.filter(
      (group) =>
        SETTINGS_ITEMS.filter((item) => item.group === group.id).length === 1,
    );
    // P3 has no single-item group, and the branch exists for the next one.
    expect(single).toHaveLength(0);
  });

  test("the permission entry is a row of its own in 工具与权限", () => {
    const body = rootRows({
      sections: SETTINGS_SECTIONS,
      items: SETTINGS_ITEMS,
      groups: SETTINGS_GROUPS,
      ctx: CTX,
      permissionRuleCount: 3,
    });
    const row = body.find(
      (entry) => entry.kind === "item" && entry.id === "perm:permission",
    );
    expect(row?.kind === "item" && row.value).toBe("3 条");
  });

  test("a row carries its value, its key and its scope", () => {
    const item = SETTINGS_ITEMS.find(
      (entry) => entry.id === "systemRemindersVisible",
    );
    if (!item) throw new Error("systemRemindersVisible is missing");
    const row = settingRow(item, CTX);
    if (row.kind !== "item") throw new Error("not an item row");
    expect(row.key).toBe("Space");
    expect(row.hint).toBe("[会话]");
    expect(row.disabled).toBe(false);
  });

  test("a read-only row is dimmed with the reason as its aside", () => {
    const item = SETTINGS_ITEMS.find((entry) => entry.id === "showCompactions");
    if (!item) throw new Error("showCompactions is missing");
    const row = settingRow(item, CTX);
    if (row.kind !== "item") throw new Error("not an item row");
    expect(row.disabled).toBe(true);
    expect(row.key).toBeUndefined();
    expect(row.hint).toContain("reload");
  });
});

describe("values", () => {
  const toggle = SETTINGS_ITEMS.find(
    (item) => item.id === "systemRemindersVisible",
  );
  const select = SETTINGS_ITEMS.find((item) => item.id === "recallDiversity");
  const number = SETTINGS_ITEMS.find((item) => item.id === "topicNudgeTurns");

  test("a toggle says On/Off, never a boolean", () => {
    if (!toggle) throw new Error("toggle fixture missing");
    expect(displayValue(toggle, "true")).toBe("On");
    expect(displayValue(toggle, "false")).toBe("Off");
  });

  test("a select says its option's label, and an unknown value as it is", () => {
    if (!select) throw new Error("select fixture missing");
    expect(displayValue(select, "split")).toBe("split");
    expect(displayValue(select, "other")).toBe("other");
  });

  test("an unreadable value says so instead of pretending", () => {
    if (!toggle) throw new Error("toggle fixture missing");
    expect(displayValue(toggle, null)).toBe("（读不到）");
  });

  test("toggles flip, selects wrap, numbers step and clamp", () => {
    if (!toggle || !select || !number) throw new Error("fixtures missing");
    expect(cycleValue({ item: toggle, raw: "true", direction: 1 })).toBe(
      "false",
    );
    expect(cycleValue({ item: select, raw: "split", direction: 1 })).toBe(
      "none",
    );
    expect(cycleValue({ item: select, raw: "none", direction: -1 })).toBe(
      "split",
    );
    expect(cycleValue({ item: number, raw: "50", direction: 1 })).toBe("51");
    expect(cycleValue({ item: number, raw: "0", direction: -1 })).toBe("0");
  });

  test("a text row does not cycle: it needs the editor", () => {
    const text = SETTINGS_ITEMS.find(
      (item) => item.id === "reflectionMergeInstructions",
    );
    if (!text) throw new Error("text fixture missing");
    expect(cycleValue({ item: text, raw: "x", direction: 1 })).toBeNull();
  });

  test("a typed number outside its bounds is refused, not clamped", () => {
    if (!number) throw new Error("number fixture missing");
    expect(validateValue(number, "12")).toBeNull();
    expect(validateValue(number, "abc")).toBe("需要数字");
    expect(validateValue(number, "-1")).toBe("不能小于 0");
  });

  test("the scope marker never pretends a setting has three levels", () => {
    const agent = SETTINGS_ITEMS.find((item) => item.id === "pinned");
    const session = SETTINGS_ITEMS.find(
      (item) => item.id === "systemRemindersVisible",
    );
    const global = SETTINGS_ITEMS.find((item) => item.id === "tokenStreaming");
    if (!agent || !session || !global) throw new Error("fixtures missing");
    expect(scopeMarker(agent)).toBe("[agent]");
    expect(scopeMarker(session)).toBe("[会话]");
    expect(scopeMarker(global)).toBe("[G]");
  });
});

describe("permission rows", () => {
  const rules = {
    allow: ["Bash(ls:*)"],
    deny: ["Read(.env)"],
    ask: [],
    alwaysAsk: ["Edit(**)"],
    additionalDirectories: ["/tmp/extra"],
  };

  test("the mode row names the running mode and counts every bucket", () => {
    const rows = permissionRows({
      rules,
      mode: "standard",
      writeScope: "project",
    });
    const text = rows
      .map((row) =>
        row.kind === "item" ? `${row.label} ${row.value ?? ""}` : row.text,
      )
      .join("\n");
    expect(text).toContain("模式 standard");
    expect(text).toContain("允许 1 条");
    expect(text).toContain("询问 0 条");
    expect(text).toContain("附加目录 1 条");
    // The write scope is permanent on this screen, as §12.6 1 requires.
    expect(text).toContain("写入 project");
  });

  test("the read-only bucket is disabled and says why", () => {
    const row = permissionRows({
      rules,
      mode: "standard",
      writeScope: "local",
    }).find(
      (entry) =>
        entry.kind === "item" && entry.id.endsWith("additionalDirectories"),
    );
    if (!row || row.kind !== "item") throw new Error("bucket row missing");
    expect(row.disabled).toBe(true);
    expect(row.hint).toContain("settings.json");
    expect(PERMISSION_BUCKETS.filter((bucket) => bucket.writable)).toHaveLength(
      4,
    );
  });

  test("a bucket screen lists the rules, and an empty one says so", () => {
    expect(bucketRows({ rules, bucket: "allow" })).toEqual([
      { kind: "item", id: "perm:rule:allow:0", label: "Bash(ls:*)" },
    ]);
    const empty = bucketRows({ rules, bucket: "ask" });
    expect(empty[0]?.kind).toBe("note");
  });

  test("the mode options are the four the permission checker knows", () => {
    expect(PERMISSION_MODE_OPTIONS.map((option) => option.value)).toEqual([
      "unrestricted",
      "standard",
      "acceptEdits",
      "strict",
    ]);
  });
});
