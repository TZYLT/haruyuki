import { describe, expect, test } from "bun:test";
import type { AuthMethod, ByokProvider } from "@/providers/byok-providers";
import { viewFor } from "./provider-selector-steps";

/**
 * `viewFor` is the one thing that maps "which step" onto "what it renders from",
 * and the property that matters is that it is **total**: a step below the list
 * with no provider picked renders the list rather than throwing or rendering a
 * half-built step, which is the same guard the renderers used to carry each on
 * their own.
 */

const PROVIDER = { providerName: "deepseek" } as ByokProvider;
const SUBJECT = { provider: PROVIDER, authMethod: null };

describe("viewFor", () => {
  test("the list step needs no subject", () => {
    expect(viewFor("list", null)).toEqual({ type: "list" });
    expect(viewFor("list", SUBJECT)).toEqual({ type: "list" });
  });

  test("a step below the list without a provider falls back to the list", () => {
    for (const step of [
      "input",
      "multiInput",
      "methodSelect",
      "profileSelect",
      "options",
      "oauthNameInput",
    ] as const) {
      expect(viewFor(step, null)).toEqual({ type: "list" });
    }
  });

  test("each step carries the provider it is about", () => {
    expect(viewFor("input", SUBJECT)).toEqual({
      type: "input",
      provider: PROVIDER,
    });
    expect(viewFor("methodSelect", SUBJECT)).toEqual({
      type: "methodSelect",
      provider: PROVIDER,
    });
    expect(viewFor("profileSelect", SUBJECT)).toEqual({
      type: "profileSelect",
      provider: PROVIDER,
    });
    expect(viewFor("options", SUBJECT)).toEqual({
      type: "options",
      provider: PROVIDER,
    });
    expect(viewFor("oauthNameInput", SUBJECT)).toEqual({
      type: "oauthNameInput",
      provider: PROVIDER,
    });
  });

  test("the multi-field step carries the auth method only when it was opened with one", () => {
    expect(viewFor("multiInput", SUBJECT)).toEqual({
      type: "multiInput",
      provider: PROVIDER,
      authMethod: undefined,
    });
    const method: AuthMethod = {
      id: "iam",
      label: "IAM",
      description: "An access key and a region",
      fields: [],
    };
    expect(
      viewFor("multiInput", { provider: PROVIDER, authMethod: method }),
    ).toEqual({
      type: "multiInput",
      provider: PROVIDER,
      authMethod: method,
    });
  });
});
