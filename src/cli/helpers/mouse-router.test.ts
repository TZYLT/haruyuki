import { afterEach, describe, expect, test } from "bun:test";
import {
  registeredMouseHandlers,
  registerMouseHandler,
  resetMouseHandlers,
  routeMouseReport,
} from "@/cli/helpers/mouse-router";
import type { MouseReport } from "@/cli/helpers/mouse-sequence";

function report(overrides: Partial<MouseReport> = {}): MouseReport {
  return {
    kind: "press",
    button: "left",
    column: 1,
    row: 1,
    modifiers: { shift: false, alt: false, ctrl: false },
    ...overrides,
  };
}

afterEach(() => {
  resetMouseHandlers();
});

describe("mouse routing", () => {
  test("hands a report to the registered handler and reports it spent", () => {
    const seen: string[] = [];
    registerMouseHandler((event) => {
      seen.push(event.wheel ?? event.kind);
      return true;
    });

    expect(routeMouseReport(report({ wheel: "up", kind: "press" }))).toBe(true);
    expect(seen).toEqual(["up"]);
  });

  test("registers each handler once and releases it", () => {
    // A declining handler is offered the report first and the next one still gets
    // its turn; the release function removes exactly its own registration.
    const seen: string[] = [];
    const releaseDeclining = registerMouseHandler(() => false);
    const releaseTaking = registerMouseHandler((event) => {
      seen.push(event.kind);
      return true;
    });
    expect(registeredMouseHandlers()).toBe(2);

    expect(routeMouseReport(report({ kind: "release" }))).toBe(true);
    expect(seen).toEqual(["release"]);

    releaseDeclining();
    expect(registeredMouseHandlers()).toBe(1);
    expect(routeMouseReport(report({ kind: "press" }))).toBe(true);

    releaseTaking();
    expect(registeredMouseHandlers()).toBe(0);
    expect(routeMouseReport(report())).toBe(false);
  });

  test("a report nobody takes is not spent", () => {
    expect(routeMouseReport(report())).toBe(false);

    registerMouseHandler(() => false);
    expect(routeMouseReport(report())).toBe(false);
  });

  test("treats a handler that returns nothing as having taken the report", () => {
    // The key-binding convention, kept identical here: a handler only opts out by
    // returning `false`.
    registerMouseHandler(() => {});
    expect(routeMouseReport(report())).toBe(true);
  });
});
