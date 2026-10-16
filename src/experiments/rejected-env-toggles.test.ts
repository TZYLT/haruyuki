import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  experimentManager,
  findRejectedEnvToggles,
} from "@/experiments/manager";

const TOGGLE_ENV_VARS = [
  "HARUYUKI_ARTIFACTS",
  "HARUYUKI_MEMORY_PALACE",
  "HARUYUKI_UI_V2",
] as const;

const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const name of TOGGLE_ENV_VARS) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of TOGGLE_ENV_VARS) {
    const value = saved.get(name);
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  saved.clear();
});

describe("findRejectedEnvToggles", () => {
  test("is empty when no toggle env var is set", () => {
    expect(findRejectedEnvToggles()).toEqual([]);
  });

  test("reports an on-word the manager treats as off", () => {
    process.env.HARUYUKI_UI_V2 = "on";

    expect(findRejectedEnvToggles()).toEqual([
      { id: "ui_v2", envVar: "HARUYUKI_UI_V2", value: "on" },
    ]);
    // The hint must not change the semantics it explains.
    expect(experimentManager.isEnabled("ui_v2")).toBe(false);
  });

  test("accepts the values the manager enables, in any case and padding", () => {
    for (const value of ["1", "true", "TRUE", "Yes", " yes "]) {
      process.env.HARUYUKI_UI_V2 = value;
      expect(findRejectedEnvToggles()).toEqual([]);
      expect(experimentManager.isEnabled("ui_v2")).toBe(true);
    }
  });

  test("says nothing about values that ask for off", () => {
    for (const value of ["0", "false", "off", "no", ""]) {
      process.env.HARUYUKI_UI_V2 = value;
      expect(findRejectedEnvToggles()).toEqual([]);
    }
  });

  test("says nothing about a value that is neither on nor off", () => {
    process.env.HARUYUKI_UI_V2 = "maybe";
    expect(findRejectedEnvToggles()).toEqual([]);
  });

  test("trims and lowercases before deciding", () => {
    for (const value of ["ON", " on ", "Enable", "ENABLED", "Y", "t"]) {
      process.env.HARUYUKI_UI_V2 = value;
      expect(findRejectedEnvToggles()).toEqual([
        { id: "ui_v2", envVar: "HARUYUKI_UI_V2", value: value.trim() },
      ]);
    }
  });

  test("covers every experiment that has an env var", () => {
    process.env.HARUYUKI_ARTIFACTS = "on";
    process.env.HARUYUKI_MEMORY_PALACE = "on";
    process.env.HARUYUKI_UI_V2 = "on";

    expect(findRejectedEnvToggles().map((toggle) => toggle.envVar)).toEqual([
      "HARUYUKI_ARTIFACTS",
      "HARUYUKI_MEMORY_PALACE",
      "HARUYUKI_UI_V2",
    ]);
  });
});
