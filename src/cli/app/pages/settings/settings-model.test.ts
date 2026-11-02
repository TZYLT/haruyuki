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
  settingItemById,
} from "@/cli/app/pages/settings/settings-schema";

/**
 * The settings page's data, without a terminal.
 *
 * The schema is the part of P3 that can be wrong in ways the frame cannot show: an
 * entry that claims to be editable but has no writer, a group row for a group that
 * does not exist, two controls over one stored key. Those are asserted here; the
 * screens, the columns and the keys are asserted on the frame
 * (`settings-page.test.tsx`).
 *
 * Copy is English throughout (reported from the first real run: a page half in
 * Chinese and half in English reads as a debug screen).
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

  test("an editable row has a writer; a read-only row says why or where", () => {
    for (const item of SETTINGS_ITEMS) {
      if (item.editable) {
        expect(item.write).toBeDefined();
      } else {
        // T-04: a read-only row answers "why not" (`reason`) or "where to go
        // instead" (`jump`); one of the two has to exist.
        expect(
          item.reason ?? item.jump,
          `${item.id} is read-only without a reason or a jump`,
        ).toBeTruthy();
        expect(item.write).toBeUndefined();
      }
    }
  });

  test("a select has options", () => {
    for (const item of SETTINGS_ITEMS) {
      if (item.kind !== "select") continue;
      expect(item.options?.length ?? 0).toBeGreaterThan(1);
    }
  });

  test("one stored key has one control", () => {
    // `experimentManager.set("conversation_titles", …)` writes the same setting as
    // `autoConversationTitles`; the page deliberately keeps only the setting.
    const ids = SETTINGS_ITEMS.map((item) => item.id);
    expect(ids).toContain("autoConversationTitles");
    expect(ids).not.toContain("experiment:conversation_titles");
  });

  test("the inventory is pinned, so an addition is a decision", () => {
    // 32 writable + 13 read-only at P3; F-06 M4 added 15 writable dream knobs
    // and one read-only setup row; T-04 added 12 rows (one writable
    // `listenerEnvName`, eleven read-only gap rows, ten of them with a jump).
    // Changing this list is fine; changing the number without a docs update is
    // what this test is for.
    expect(SETTINGS_ITEMS.filter((item) => item.editable)).toHaveLength(48);
    expect(SETTINGS_ITEMS).toHaveLength(73);
  });

  test("T-04's twelve gap rows are present with their scope and owner", () => {
    const expected: ReadonlyArray<{
      id: string;
      scope: string;
      jump?: string;
      editable: boolean;
    }> = [
      {
        id: "compactionMode",
        scope: "[agent]",
        jump: "/compact config",
        editable: false,
      },
      {
        id: "compactionPrompt",
        scope: "[agent]",
        jump: "/compact config",
        editable: false,
      },
      {
        id: "compactionClipChars",
        scope: "[agent]",
        jump: "/compact config",
        editable: false,
      },
      {
        id: "compactionKeepPercentage",
        scope: "[agent]",
        jump: "/compact config",
        editable: false,
      },
      {
        id: "maxContext",
        scope: "[model]",
        jump: "/context limit",
        editable: false,
      },
      {
        id: "windowTitleProject",
        scope: "[Project]",
        jump: "/config title",
        editable: false,
      },
      {
        id: "windowTitleLocal",
        scope: "[Local]",
        jump: "/config title",
        editable: false,
      },
      {
        id: "consoleFont",
        scope: "[Global]",
        jump: "/config console-font",
        editable: false,
      },
      {
        id: "hooksSummary",
        scope: "[Global]",
        jump: "/config hooks",
        editable: false,
      },
      {
        id: "mcpServers",
        scope: "[agent]",
        jump: "/config mcp",
        editable: false,
      },
      {
        id: "worktreeProjectConfig",
        scope: "[Project]",
        editable: false,
      },
      {
        id: "listenerEnvName",
        scope: "[Local]",
        editable: true,
      },
    ];
    for (const entry of expected) {
      const item = settingItemById(entry.id);
      expect(item, `${entry.id} is missing`).toBeDefined();
      if (!item) continue;
      expect(scopeMarker(item)).toBe(entry.scope);
      expect(item.jump).toBe(entry.jump);
      expect(item.editable).toBe(entry.editable);
    }
    // The gaps are twelve rows and exactly one of them writes.
    const gapIds = new Set(expected.map((entry) => entry.id));
    const gaps = SETTINGS_ITEMS.filter((item) => gapIds.has(item.id));
    expect(gaps).toHaveLength(12);
    expect(gaps.filter((item) => item.editable)).toHaveLength(1);
    // `env` is an OAuth-refresh side channel, not a user setting (R-04.4).
    expect(SETTINGS_ITEMS.some((item) => item.id === "env")).toBe(false);
  });

  test("the Dream group carries R-5.9.2's minimal set, one control per key", () => {
    const ids = SETTINGS_ITEMS.filter((item) => item.group === "dream").map(
      (item) => item.id,
    );
    for (const id of [
      "dreamEnabled",
      "dreamPermissionMode",
      "dreamIdleWindows",
      "dreamSilenceMinutes",
      "dreamPressureThreshold",
      "dreamBudgetFactor",
      "dreamMaxPerRun",
      "dreamMaxPerDay",
      "dreamTimeLimitMinutes",
      "dreamAutoTrigger",
      "dreamOverBudgetApprovals",
      "dreamTier-tidy",
      "dreamTier-think",
      "dreamTier-task",
      "dreamTier-wander",
    ]) {
      expect(ids).toContain(id);
    }
    // The per-agent override map is not a second control over the same knobs.
    expect(ids).not.toContain("dreamSettingsByAgent");
  });

  test("the copy is English: no CJK left in a label or a reason", () => {
    for (const item of SETTINGS_ITEMS) {
      expect(item.label).not.toMatch(/[\u4e00-\u9fff]/);
      expect(item.reason ?? "").not.toMatch(/[\u4e00-\u9fff]/);
      for (const option of item.options ?? []) {
        expect(option.label).not.toMatch(/[\u4e00-\u9fff]/);
      }
    }
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
    expect(headers.map((row) => row.text)).toContain("Context");
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
    expect(group?.kind === "item" && group.value).toBe("10 items");
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

  test("the permission entry is a row of its own under Tools & permissions", () => {
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
    expect(row?.kind === "item" && row.value).toBe("3 rules");
  });

  test("every row carries a scope marker in its own column", () => {
    // The marker used to be the row's last cell and was the first thing a narrow
    // terminal cut; keeping it out of the value is what the frame test then checks.
    for (const item of SETTINGS_ITEMS) {
      const row = settingRow(item, CTX);
      if (row.kind !== "item") throw new Error(`${item.id} is not an item row`);
      expect(row.hint).toMatch(/^\[[A-Za-z-]+\]$/);
      expect(row.key).toBeUndefined();
    }
  });

  test("a read-only row is dimmed and carries its reason with the value", () => {
    const item = SETTINGS_ITEMS.find((entry) => entry.id === "showCompactions");
    if (!item) throw new Error("showCompactions is missing");
    const row = settingRow(item, CTX);
    if (row.kind !== "item") throw new Error("not an item row");
    expect(row.disabled).toBe(true);
    expect(row.hint).toBe("[Global]");
    expect(row.note).toBe("start or /reload");
  });

  test("a jump row is focusable and carries its command, but is not editable", () => {
    // R-04.3 / Q-48: the row must not pretend to be editable, but `Enter` on it
    // is a real action (prefill the composer), so it is not disabled either.
    for (const item of SETTINGS_ITEMS.filter((entry) => entry.jump)) {
      expect(item.editable).toBe(false);
      expect(item.write).toBeUndefined();
      const row = settingRow(item, CTX);
      if (row.kind !== "item") throw new Error(`${item.id} is not an item row`);
      expect(row.disabled, `${item.id} must be focusable`).not.toBe(true);
      expect(row.note, `${item.id} carries its jump`).toBe(item.jump);
    }
  });

  test("the worktree row explains its file and stays a plain read-only row", () => {
    // §1.4 #1: the worktree block is read by the tool from disk, so the panel
    // only points at the file — it has no jump and no writer.
    const item = SETTINGS_ITEMS.find(
      (entry) => entry.id === "worktreeProjectConfig",
    );
    if (!item) throw new Error("worktreeProjectConfig is missing");
    expect(item.jump).toBeUndefined();
    expect(item.editable).toBe(false);
    const row = settingRow(item, CTX);
    if (row.kind !== "item") throw new Error("not an item row");
    expect(row.disabled).toBe(true);
    expect(row.value).toBe(".haruyuki/settings.json");
    expect(row.note).toBe("edit on disk");
  });

  test("a row that needs a restart says so", () => {
    // `requiresRestart` was assigned by seven schema entries and read by nobody:
    // flipping `ui_v2` here rewrote a file, nothing on screen moved, and the page
    // said nothing about why. The aside column is where the page already tells the
    // reader "the value you see is not the whole story".
    const item = SETTINGS_ITEMS.find(
      (entry) => entry.id === "experiment:ui_v2",
    );
    if (!item) throw new Error("ui_v2 is missing from the schema");
    const row = settingRow(item, CTX);
    if (row.kind !== "item") throw new Error("not an item row");
    expect(row.note).toBe("restart");
    // And a row that takes effect immediately stays quiet.
    const live = SETTINGS_ITEMS.find((entry) => entry.id === "showCompactions");
    if (!live) throw new Error("showCompactions is missing");
    const liveRow = settingRow(live, CTX);
    if (liveRow.kind !== "item") throw new Error("not an item row");
    expect(liveRow.note).not.toBe("restart");
  });
});

describe("T-04 gap rows", () => {
  /** The agent state the shell would hand the page, minus the fields it reads. */
  const AGENT_STATE = {
    compaction_settings: {
      mode: "sliding_window",
      prompt: "Summarize briefly",
      clip_chars: 2000,
      sliding_window_percentage: 0.7,
    },
  } as unknown as NonNullable<SettingsContext["agentState"]>;

  const gapsCtx: SettingsContext = {
    ...CTX,
    agentState: AGENT_STATE,
    contextWindowSize: 200_000,
  };

  const itemOf = (id: string) => {
    const item = SETTINGS_ITEMS.find((entry) => entry.id === id);
    if (!item) throw new Error(`${id} is missing`);
    return item;
  };

  const rowValueOf = (id: string, ctx: SettingsContext): string => {
    const row = settingRow(itemOf(id), ctx);
    if (row.kind !== "item") throw new Error(`${id} is not an item row`);
    return row.value ?? "";
  };

  test("the compaction rows read the agent's stored values", () => {
    expect(rowValueOf("compactionMode", gapsCtx)).toBe("sliding_window");
    expect(rowValueOf("compactionPrompt", gapsCtx)).toBe("Summarize briefly");
    expect(rowValueOf("compactionClipChars", gapsCtx)).toBe("2000");
    expect(rowValueOf("compactionKeepPercentage", gapsCtx)).toBe("70%");
  });

  test("the compaction rows say what the runtime defaults to, not a fake zero", () => {
    const bare: SettingsContext = { ...CTX, agentState: null };
    expect(rowValueOf("compactionMode", bare)).toBe("(default)");
    expect(rowValueOf("compactionPrompt", bare)).toBe("(mode default)");
    expect(rowValueOf("compactionClipChars", bare)).toBe("(no clip)");
    expect(rowValueOf("compactionKeepPercentage", bare)).toBe("(default)");
  });

  test("max context formats the shell's window, and says so when unknown", () => {
    expect(rowValueOf("maxContext", gapsCtx)).toBe("200k tokens");
    expect(rowValueOf("maxContext", CTX)).toBe("(unreadable)");
  });

  test("the hooks row is the synchronous three-layer summary", () => {
    // With no settings loaded every layer counts zero; the point is the shape,
    // and that reading it needs no backend round trip.
    expect(rowValueOf("hooksSummary", CTX)).toMatch(
      /^\d+g · \d+p · \d+l( \(off\))?$/,
    );
  });

  test("the per-agent MCP row says it cannot read before the manager loads", () => {
    // The schema is exercised without an initialized settings manager here; the
    // page's rule is to say so rather than paint "none" (a real "no servers").
    expect(rowValueOf("mcpServers", CTX)).toBe("(unreadable)");
  });

  test("listenerEnvName is the one writable gap row, local and directly editable", () => {
    const item = itemOf("listenerEnvName");
    expect(item.editable).toBe(true);
    expect(item.kind).toBe("text");
    expect(item.scope).toBe("local");
    expect(item.write).toBeDefined();
    expect(typeof item.read(CTX)).toBe("string");
  });

  test("the T-04 rows are split out of settings-schema.ts", () => {
    // The parent file only spreads the gap table (the Dream precedent); the
    // twelve rows and their formatters live in settings-gaps-schema.ts.
    expect(SETTINGS_GROUPS.some((group) => group.id === "compaction")).toBe(
      true,
    );
    expect(
      SETTINGS_GROUPS.some((group) => group.id === "windowTitleLayers"),
    ).toBe(true);
    expect(
      SETTINGS_GROUPS.find((group) => group.id === "compaction")?.section,
    ).toBe("context");
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
    expect(displayValue(toggle, null)).toBe("(unreadable)");
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
    const text = SETTINGS_ITEMS.find((item) => item.id === "currentModel");
    if (!text) throw new Error("text fixture missing");
    expect(cycleValue({ item: text, raw: "x", direction: 1 })).toBeNull();
  });

  test("a typed number outside its bounds is refused, not clamped", () => {
    if (!number) throw new Error("number fixture missing");
    expect(validateValue(number, "12")).toBeNull();
    expect(validateValue(number, "abc")).toBe("needs a number");
    expect(validateValue(number, "-1")).toBe("must be at least 0");
  });

  test("the scope marker never pretends a setting has three levels", () => {
    const agent = SETTINGS_ITEMS.find((item) => item.id === "pinned");
    const session = SETTINGS_ITEMS.find(
      (item) => item.id === "systemRemindersVisible",
    );
    const global = SETTINGS_ITEMS.find((item) => item.id === "tokenStreaming");
    if (!agent || !session || !global) throw new Error("fixtures missing");
    expect(scopeMarker(agent)).toBe("[agent]");
    expect(scopeMarker(session)).toBe("[session]");
    expect(scopeMarker(global)).toBe("[Global]");
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
    expect(text).toContain("Mode standard");
    expect(text).toContain("Allow 1 rule");
    expect(text).toContain("Ask 0 rules");
    expect(text).toContain(
      "Extra directories 1 rule · No write path (edit settings.json)",
    );
    // The write scope is permanent on this screen, as §12.6 1 requires.
    expect(text).toContain("Write to project");
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
    // The reason rides with the value now: a 16-cell column would cut it.
    expect(row.value).toContain("settings.json");
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
