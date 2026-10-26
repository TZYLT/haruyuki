import { expect, test } from "bun:test";
import {
  SUBAGENT_LAUNCH_PROFILE_ENV,
  USAGE_RUN_ID_ENV,
  USAGE_SOURCE_ENV,
} from "@/utils/subagent-launch-marker";
import {
  composeSubagentChildEnv,
  shouldLaunchThroughListener,
} from "./subagent-launcher";

test("only an explicit computer route sends a child through a listener", () => {
  expect(
    shouldLaunchThroughListener({
      launchProfile: "default",
      computer: "cloud",
    }),
  ).toBe(true);
  expect(
    shouldLaunchThroughListener({
      launchProfile: "default",
      computer: "remote",
    }),
  ).toBe(true);
  expect(shouldLaunchThroughListener({ launchProfile: "default" })).toBe(false);
});

test("ephemeral launches stay local and reject explicit computer routing", () => {
  expect(shouldLaunchThroughListener({ ephemeral: true })).toBe(false);
  expect(() =>
    shouldLaunchThroughListener({ computer: "cloud", ephemeral: true }),
  ).toThrow("Ephemeral conversations");
});

test("memory workers remain confined processes, without a listener route", () => {
  const env = composeSubagentChildEnv({
    parentProcessEnv: {},
    subagentType: "memory",
    parentAgentId: "agent-parent",
    launchProfile: "memory-subagent",
    inheritedPrimaryRoot: "/memory",
  });
  expect(env[SUBAGENT_LAUNCH_PROFILE_ENV]).toBe("memory-subagent");
  expect(env.MEMORY_DIR).toBe("/memory");
  expect(
    shouldLaunchThroughListener({ launchProfile: "memory-subagent" }),
  ).toBe(false);
  expect(() =>
    shouldLaunchThroughListener({
      computer: "cloud",
      launchProfile: "memory-subagent",
    }),
  ).toThrow("confined local process");
});

test("an ordinary child's caller routes it without changing the parent's environment", () => {
  const parentProcessEnv = { USER_CWD: "/workspace" };
  const env = composeSubagentChildEnv({
    parentProcessEnv,
    subagentType: "general-purpose",
    parentAgentId: "agent-parent",
    inheritedPrimaryRoot: null,
    launchProfile: "default",
  });
  expect(parentProcessEnv).toEqual({ USER_CWD: "/workspace" });
  expect(env.USER_CWD).toBe("/workspace");
});

test("only the reflection launch tags the child with an automated usage source", () => {
  const base = {
    parentProcessEnv: {},
    subagentType: "reflection",
    parentAgentId: "agent-parent",
    inheritedPrimaryRoot: "/memory",
    launchProfile: "memory-subagent" as const,
  };
  const tagged = composeSubagentChildEnv({
    ...base,
    usageSource: "reflection",
    usageRunId: "reflection-agent-parent-1",
  });
  expect(tagged[USAGE_SOURCE_ENV]).toBe("reflection");
  expect(tagged[USAGE_RUN_ID_ENV]).toBe("reflection-agent-parent-1");

  // An untagged launch of the same type carries neither: the tag describes one
  // spawn, not the subagent type.
  const untagged = composeSubagentChildEnv(base);
  expect(untagged[USAGE_SOURCE_ENV]).toBeUndefined();
  expect(untagged[USAGE_RUN_ID_ENV]).toBeUndefined();
});

test("a nested launch never inherits its parent's automated usage tag", () => {
  const env = composeSubagentChildEnv({
    parentProcessEnv: {
      [USAGE_SOURCE_ENV]: "reflection",
      [USAGE_RUN_ID_ENV]: "reflection-agent-parent-1",
    },
    subagentType: "general-purpose",
    parentAgentId: "agent-parent",
    inheritedPrimaryRoot: null,
    launchProfile: "default",
  });
  // Otherwise a reflection's own worker would report reflection spend it never
  // did, and the parent's run would be counted twice.
  expect(env[USAGE_SOURCE_ENV]).toBeUndefined();
  expect(env[USAGE_RUN_ID_ENV]).toBeUndefined();
});
