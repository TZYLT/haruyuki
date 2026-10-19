import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandHandle } from "@/cli/commands/runner";
import { getNotice, resetNoticeForTests } from "@/cli/helpers/notice";
import {
  getSwitchPolicy,
  queueOrRefuseSwitch,
  resetSwitchPolicyForTests,
  SWITCH_QUEUED_NOTICE,
  SWITCH_REFUSED_NOTICE,
  setSwitchPolicy,
} from "./switch-policy";

/**
 * The shell's switch policy, and the one call that spends a busy switch.
 *
 * The decision has two sides and only one of them is new behaviour: `refuse` is
 * the full-screen shell's answer (a switch asked for mid-turn is refused and said
 * out loud), `queue` is what has always happened (defer to the end of the turn).
 * Both are pinned here, because a policy that silently defaults to "queue" in the
 * new shell would look exactly like this feature not being wired at all.
 */

type Recorded = {
  failures: string[];
  updates: { output: string; phase?: string }[];
  started: string[];
};

function fakeCommand(recorded: Recorded): CommandHandle {
  return {
    id: "cmd-1",
    input: "/resume",
    update: (update) => {
      recorded.updates.push(update);
    },
    finish: () => {},
    fail: (output) => {
      recorded.failures.push(output);
    },
  };
}

afterEach(() => {
  resetSwitchPolicyForTests();
  resetNoticeForTests();
});

describe("the switch policy", () => {
  test("defaults to the compatibility answer", () => {
    expect(getSwitchPolicy()).toBe("queue");
    setSwitchPolicy("refuse");
    expect(getSwitchPolicy()).toBe("refuse");
  });

  test("refusing reports on the notice line and fails the command", () => {
    setSwitchPolicy("refuse");
    const recorded: Recorded = { failures: [], updates: [], started: [] };
    const deferred: (string | undefined)[] = [];

    queueOrRefuseSwitch({
      command: fakeCommand(recorded),
      output: "queued…",
      defer: (commandId) => deferred.push(commandId),
    });

    // Nothing is deferred, the row stops waiting, and the user is told why.
    expect(deferred).toEqual([]);
    expect(recorded.updates).toEqual([]);
    expect(recorded.failures).toEqual([SWITCH_REFUSED_NOTICE]);
    expect(getNotice()).toBe(SWITCH_REFUSED_NOTICE);
  });

  test("deferring keeps today's behaviour: the row runs, then the action waits", () => {
    const recorded: Recorded = { failures: [], updates: [], started: [] };
    const deferred: (string | undefined)[] = [];

    queueOrRefuseSwitch({
      command: fakeCommand(recorded),
      output: "queued…",
      defer: (commandId) => deferred.push(commandId),
    });

    expect(recorded.failures).toEqual([]);
    expect(recorded.updates).toEqual([{ output: "queued…", phase: "running" }]);
    expect(deferred).toEqual(["cmd-1"]);
    expect(getNotice()).toBe(SWITCH_QUEUED_NOTICE);
  });

  test("a click defers without a command row to re-open", () => {
    const deferred: (string | undefined)[] = [];
    queueOrRefuseSwitch({
      output: "queued…",
      defer: (commandId) => deferred.push(commandId),
    });
    expect(deferred).toEqual([undefined]);
  });

  test("a click refused under the new policy leaves no row behind either", () => {
    setSwitchPolicy("refuse");
    const deferred: (string | undefined)[] = [];
    queueOrRefuseSwitch({
      output: "queued…",
      defer: (commandId) => deferred.push(commandId),
    });
    expect(deferred).toEqual([]);
    expect(getNotice()).toBe(SWITCH_REFUSED_NOTICE);
  });

  test("each shell declares its own answer, where the shells already differ", () => {
    // The declaration is one line in each shell; the point of the assertion is
    // that it exists there and not in core, so a future handler cannot answer
    // differently by reading the mode.
    const shellDir = join(import.meta.dir, "shell");
    const v2 = readFileSync(join(shellDir, "V2Shell.tsx"), "utf8");
    const legacy = readFileSync(join(shellDir, "LegacyShell.tsx"), "utf8");
    expect(v2).toContain('useSwitchPolicy("refuse")');
    expect(legacy).toContain('useSwitchPolicy("queue")');
  });
});
