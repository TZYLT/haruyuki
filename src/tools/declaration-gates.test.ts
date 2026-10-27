/**
 * The declaration gate for the topic channel (requirement §5.11).
 *
 * `filterDeclaredTopicMarkingTools` decides whether the *declared payload* may
 * carry `TopicMark` and `TopicQuery`. The pair moves together: the switch means
 * "this conversation does not mark topics", and a reader left declared without
 * the writer advertises half a feature.
 *
 * These cases are unit-level on purpose — the end-to-end payload assertion lives
 * in `topic-marking-switch.test.ts`, which builds a real `client_tools` array.
 * What this file pins is the contract the filter itself must hold: the registry
 * is copied rather than mutated, an absent name is not an error, and a no-op
 * returns the very same map.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testSetBackend } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import { LocalBackend } from "@/backend/local/local-backend";
import { settingsManager } from "@/settings-manager";
import {
  filterDeclaredTopicMarkingTools,
  shouldDeclareTopicMarkingTool,
} from "@/tools/declaration-gates";

const originalHome = process.env.HOME;
let testHomeDir: string;

beforeEach(async () => {
  await settingsManager.reset();
  testHomeDir = await mkdtemp(join(tmpdir(), "declaration-gates-home-"));
  process.env.HOME = testHomeDir;
  await settingsManager.initialize();
});

afterEach(async () => {
  __testSetBackend(null);
  await settingsManager.reset();
  await rm(testHomeDir, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

/** A local backend stands in for "the declaration is meaningful here". */
function useLocalBackend(): void {
  __testSetBackend(
    new LocalBackend({
      storageDir: join(testHomeDir, "local-backend"),
      memfsEnabled: false,
    }),
  );
}

function disableTopicMarking(): void {
  settingsManager.updateSettings({ topicMarkingEnabled: false });
}

function registry(names: readonly string[]): Map<string, { declared: true }> {
  return new Map(names.map((name) => [name, { declared: true } as const]));
}

describe("filterDeclaredTopicMarkingTools", () => {
  test("drops both tools when the switch is off", () => {
    useLocalBackend();
    disableTopicMarking();
    expect(shouldDeclareTopicMarkingTool()).toBe(false);
    const declared = registry(["Read", "TopicMark", "TopicQuery"]);

    const filtered = filterDeclaredTopicMarkingTools(declared);

    expect([...filtered.keys()]).toEqual(["Read"]);
    // The input map is not mutated: the execution registry and the declared one
    // are different objects, and a filter must never reach into the former.
    expect([...declared.keys()]).toEqual(["Read", "TopicMark", "TopicQuery"]);
  });

  test("keeps both tools when the switch is on", () => {
    useLocalBackend();
    const declared = registry(["Read", "TopicMark", "TopicQuery"]);

    expect(shouldDeclareTopicMarkingTool()).toBe(true);
    expect(filterDeclaredTopicMarkingTools(declared)).toBe(declared);
    expect([...filterDeclaredTopicMarkingTools(declared).keys()]).toEqual([
      "Read",
      "TopicMark",
      "TopicQuery",
    ]);
  });

  test("tolerates a registry that declares only the query tool", () => {
    useLocalBackend();
    disableTopicMarking();

    expect([
      ...filterDeclaredTopicMarkingTools(registry(["TopicQuery"])).keys(),
    ]).toEqual([]);
    expect([
      ...filterDeclaredTopicMarkingTools(registry(["TopicMark"])).keys(),
    ]).toEqual([]);
  });

  test("returns the same map when neither tool is present", () => {
    useLocalBackend();
    disableTopicMarking();
    const declared = registry(["Read", "Bash"]);

    expect(filterDeclaredTopicMarkingTools(declared)).toBe(declared);
  });

  test("drops both tools on a non-local backend", () => {
    // The fake backend is not a LocalBackend, so the channel is not declared even
    // with the switch on: markers are rows in the local transcript.
    __testSetBackend(new FakeHeadlessBackend());

    expect(shouldDeclareTopicMarkingTool()).toBe(false);
    expect([
      ...filterDeclaredTopicMarkingTools(
        registry(["Read", "TopicMark", "TopicQuery"]),
      ).keys(),
    ]).toEqual(["Read"]);
  });
});
