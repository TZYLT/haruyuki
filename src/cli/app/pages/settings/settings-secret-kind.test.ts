import { describe, expect, test } from "bun:test";
import {
  cycleValue,
  displayValue,
  editorDraft,
  type SettingsItem,
  type SettingsKind,
  validateValue,
} from "@/cli/app/pages/settings/settings-model";
import { settingsEditorMask } from "@/cli/app/pages/settings/settings-page";

/**
 * The `secret` kind D3 adds to the settings page.
 *
 * Three behaviours make a secret row different from a text row, and each is one
 * assertion here: the editor paints the mask, the value never cycles, and the
 * only validation is the row's own (no numeric or option parsing).
 */

const SECRET_ITEM: SettingsItem = {
  id: "recallEmbeddingApiKey",
  section: "memory",
  label: "Endpoint API key",
  kind: "secret",
  scope: "global",
  editable: true,
  validate: (value) => (value.trim().length === 0 ? "needs an API key" : null),
  read: () => "hidden (write-only)",
};

describe("the secret settings kind", () => {
  test("is part of the kind union", () => {
    const kind: SettingsKind = "secret";
    expect(kind).toBe("secret");
  });

  test("the editor paints a mask, every other kind does not", () => {
    expect(settingsEditorMask("secret")).toBe("*");
    for (const kind of [
      "toggle",
      "select",
      "number",
      "text",
      undefined,
    ] as const) {
      expect(settingsEditorMask(kind)).toBeUndefined();
    }
  });

  test("the row value is the schema's presence word, not a value", () => {
    expect(displayValue(SECRET_ITEM, "hidden (write-only)")).toBe(
      "hidden (write-only)",
    );
  });

  test("the masked editor opens empty, never seeded with the presence word", () => {
    // Seeding "hidden (write-only)" would be invisible behind the mask, and a
    // bare Enter would then write that word as the endpoint API key.
    expect(editorDraft(SECRET_ITEM, "hidden (write-only)")).toBe("");
    expect(editorDraft(SECRET_ITEM, "set (write-only)")).toBe("");
    expect(editorDraft(SECRET_ITEM, null)).toBe("");
    // Every other kind still opens on its value, and says so when unreadable.
    const text: SettingsItem = { ...SECRET_ITEM, kind: "text", read: () => "" };
    expect(editorDraft(text, "bge-small-zh-v1.5")).toBe("bge-small-zh-v1.5");
    expect(editorDraft(text, null)).toBe("");
  });

  test("a secret value never cycles with the arrows", () => {
    for (const direction of [1, -1] as const) {
      expect(
        cycleValue({ item: SECRET_ITEM, raw: "anything", direction }),
      ).toBeNull();
    }
  });

  test("validation is the row's own, not the number/option checks", () => {
    expect(validateValue(SECRET_ITEM, "")).toBe("needs an API key");
    expect(validateValue(SECRET_ITEM, "sk-live-abc")).toBeNull();
    // Text that would fail a number row is accepted: the mask is presentation,
    // and a key is opaque by definition.
    expect(validateValue(SECRET_ITEM, "a key with spaces")).toBeNull();
  });
});
