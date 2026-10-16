import { afterEach, describe, expect, test } from "bun:test";
import {
  armLeader,
  disarmLeader,
  isLeaderArmed,
  isLeaderHelpOpen,
  LEADER_TIMEOUT_MS,
  resetLeader,
  subscribeToLeader,
} from "@/cli/helpers/leader";

afterEach(() => {
  resetLeader();
});

describe("the leader prefix", () => {
  test("starts disarmed", () => {
    expect(isLeaderArmed()).toBe(false);
    expect(isLeaderHelpOpen()).toBe(false);
  });

  test("arms and tells its subscribers once", () => {
    let notifications = 0;
    subscribeToLeader(() => {
      notifications += 1;
    });
    armLeader();
    expect(isLeaderArmed()).toBe(true);
    expect(notifications).toBe(1);
    // Arming again is a no-op for listeners: nothing changed that they render.
    armLeader();
    expect(notifications).toBe(1);
  });

  test("the help entry re-arms with the list open", () => {
    armLeader();
    armLeader({ help: true });
    expect(isLeaderArmed()).toBe(true);
    expect(isLeaderHelpOpen()).toBe(true);
    // A plain re-arm collapses the list again.
    armLeader();
    expect(isLeaderHelpOpen()).toBe(false);
  });

  test("disarms, without notifying when there was nothing armed", () => {
    let notifications = 0;
    subscribeToLeader(() => {
      notifications += 1;
    });
    disarmLeader();
    expect(notifications).toBe(0);
    armLeader();
    disarmLeader();
    expect(isLeaderArmed()).toBe(false);
    expect(notifications).toBe(2);
  });

  test("gives up on its own after the timeout", async () => {
    // A real timer, deliberately: the prefix must expire without another event,
    // and a fake clock would not prove that the timer is actually scheduled. A
    // short window keeps the test quick; the production value is pinned below.
    armLeader({ timeoutMs: 40 });
    expect(isLeaderArmed()).toBe(true);
    await Bun.sleep(140);
    expect(isLeaderArmed()).toBe(false);
    expect(isLeaderHelpOpen()).toBe(false);
  });

  test("the default window is a reading budget, not a reflex test", () => {
    // It was 2000ms, and a user reading the which-key hint before pressing its
    // key lost the window: the second key went into the draft instead of running
    // the command. Anyone shortening this must keep it readable.
    expect(LEADER_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
  });

  test("does not expire while the help list is open", async () => {
    armLeader({ help: true, timeoutMs: 30 });
    await Bun.sleep(150);
    expect(isLeaderArmed()).toBe(true);
    expect(isLeaderHelpOpen()).toBe(true);
    // Leaving is still possible, and a plain re-arm puts the window back.
    disarmLeader();
    expect(isLeaderArmed()).toBe(false);
  });

  test("re-arming the plain prefix restores the window", async () => {
    armLeader({ timeoutMs: 40 });
    await Bun.sleep(20);
    armLeader({ timeoutMs: 40 });
    await Bun.sleep(20);
    // The first window would have expired by now; the refresh kept it armed.
    expect(isLeaderArmed()).toBe(true);
    await Bun.sleep(140);
    expect(isLeaderArmed()).toBe(false);
  });
});
