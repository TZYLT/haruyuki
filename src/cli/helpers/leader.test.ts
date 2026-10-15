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
    // and a fake clock would not prove that the timer is actually scheduled.
    const started = Date.now();
    armLeader();
    expect(isLeaderArmed()).toBe(true);
    await Bun.sleep(LEADER_TIMEOUT_MS + 250);
    expect(isLeaderArmed()).toBe(false);
    expect(isLeaderHelpOpen()).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(LEADER_TIMEOUT_MS - 50);
  });
});
