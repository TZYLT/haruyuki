/**
 * `DreamNote` (F-06 §2.4, W15).
 *
 * The tool is the main agent's entrance to the same queue the slash command
 * writes. The cases pin the two authors (a normal session writes `agent`, a
 * dream run writes `dream`), the agent resolution order (`agent_id` beats the
 * runtime context), the queue's refusal messages being passed through instead of
 * swallowed, and the declaration the model actually sees.
 *
 * `HARUYUKI_HOME` is a fresh temp directory per case: the tool writes real queue
 * files, and no case may touch the operator's harness home.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendNote,
  DREAM_NOTE_MAX_QUEUE,
  DREAM_NOTE_MAX_TEXT_CHARS,
  listNotes,
} from "@/agent/dream/dream-notes";
import { checkPermission } from "@/permissions/checker";
import type { PermissionRules } from "@/permissions/types";
import { runWithRuntimeContext } from "@/runtime-context";
import { serializeFunctionOnlyToolPayload } from "@/tools/model-facing-tool";
import { TOOL_DEFINITIONS } from "@/tools/tool-definitions";
import { dream_note } from "./dream-note";

const AGENT_ID = "agent-dream-note-tool";
const NOW = Date.parse("2026-10-31T13:20:00.000Z");
const NO_RULES: PermissionRules = { allow: [], deny: [], ask: [] };

let homeDir: string;
let previousHaruyukiHome: string | undefined;

beforeEach(async () => {
  previousHaruyukiHome = process.env.HARUYUKI_HOME;
  homeDir = await mkdtemp(join(tmpdir(), "haruyuki-dream-note-tool-"));
  process.env.HARUYUKI_HOME = homeDir;
});

afterEach(async () => {
  if (previousHaruyukiHome === undefined) delete process.env.HARUYUKI_HOME;
  else process.env.HARUYUKI_HOME = previousHaruyukiHome;
  await rm(homeDir, { recursive: true, force: true });
});

describe("the tool writes the shared queue", () => {
  test("a normal session's note is authored by the agent", async () => {
    const result = await dream_note(
      { text: "  tidy the projects folder  " },
      { agentId: AGENT_ID, now: NOW, conversationId: "conv-7" },
    );
    expect(result.status).toBe("success");
    expect(result.ok).toBe(true);
    expect(result.note_id).toMatch(/^note-[0-9a-f]{8}$/);
    expect(result.content).toContain(result.note_id ?? "");
    expect(result.content).toContain("not a memory write");

    const noteId = result.note_id;
    if (noteId === null) throw new Error("expected a note id");
    const notes = await listNotes(AGENT_ID);
    expect(notes).toEqual([
      {
        version: 1,
        id: noteId,
        createdAt: NOW,
        author: "agent",
        text: "tidy the projects folder",
        source: { conversationId: "conv-7" },
      },
    ]);
  });

  test("a dream run's note is authored by the dream, from the runtime context", async () => {
    const result = await runWithRuntimeContext(
      { agentId: AGENT_ID, conversationId: "hidden-conv", dreamRun: true },
      () => dream_note({ text: "next run: finish the archive index" }),
    );
    expect(result.status).toBe("success");
    const notes = await listNotes(AGENT_ID);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.author).toBe("dream");
    expect(notes[0]?.source.conversationId).toBe("hidden-conv");
  });

  test("an explicit agent_id overrides the current agent", async () => {
    const result = await runWithRuntimeContext(
      { agentId: "someone-else" },
      () =>
        dream_note({ text: "for the other agent", agent_id: " target-agent " }),
    );
    expect(result.status).toBe("success");
    expect(await listNotes("someone-else")).toEqual([]);
    expect((await listNotes("target-agent"))[0]?.text).toBe(
      "for the other agent",
    );
  });

  test("no agent anywhere is an error, not a write into a shared queue", async () => {
    const result = await dream_note({ text: "orphan note" });
    expect(result.status).toBe("error");
    expect(result.ok).toBe(false);
    expect(result.note_id).toBeNull();
    expect(result.content).toContain("no agent is available");
  });
});

describe("argument validation", () => {
  test("missing or empty text is refused", async () => {
    for (const args of [{}, { text: "" }, { text: "   " }, { text: 42 }]) {
      const result = await dream_note(args, { agentId: AGENT_ID, now: NOW });
      expect(result.status).toBe("error");
      expect(result.ok).toBe(false);
    }
    expect(await listNotes(AGENT_ID)).toEqual([]);
  });

  test("text over the limit is refused instead of truncated", async () => {
    const result = await dream_note(
      { text: "x".repeat(DREAM_NOTE_MAX_TEXT_CHARS + 1) },
      { agentId: AGENT_ID, now: NOW },
    );
    expect(result.status).toBe("error");
    expect(result.content).toContain(String(DREAM_NOTE_MAX_TEXT_CHARS));
    expect(await listNotes(AGENT_ID)).toEqual([]);
  });

  test("a full queue's error is passed through to the model", async () => {
    for (let index = 0; index < DREAM_NOTE_MAX_QUEUE; index += 1) {
      await appendNote(AGENT_ID, {
        text: `queued ${index}`,
        author: "user",
        now: NOW,
      });
    }
    const result = await dream_note(
      { text: "one too many" },
      { agentId: AGENT_ID, now: NOW },
    );
    expect(result.status).toBe("error");
    expect(result.content).toContain("full");
    expect(await listNotes(AGENT_ID)).toHaveLength(DREAM_NOTE_MAX_QUEUE);
  });
});

describe("the permission default (ordinary sessions)", () => {
  function decide(
    mode: "standard" | "acceptEdits" | "unrestricted" | "strict",
    rules: PermissionRules = NO_RULES,
    dreamRun = false,
  ) {
    return runWithRuntimeContext({ agentId: AGENT_ID, dreamRun }, () =>
      checkPermission(
        "DreamNote",
        { text: "a note" },
        rules,
        homeDir,
        { mode },
        AGENT_ID,
      ),
    ).decision;
  }

  test("a normal session may leave a note without an approval prompt", () => {
    // The tool only appends one line to the agent's own queue under the
    // harness home: no memory write, no conversation write, no external effect.
    expect(decide("standard")).toBe("allow");
    expect(decide("acceptEdits")).toBe("allow");
    expect(decide("unrestricted")).toBe("allow");
  });

  test("strict mode still asks, and an explicit deny rule still wins", () => {
    expect(decide("strict")).toBe("ask");
    expect(
      decide("standard", { allow: [], deny: ["DreamNote"], ask: [] }),
    ).toBe("deny");
  });

  test("a dream run is covered by the dream allowance, not only this one", () => {
    expect(decide("acceptEdits", NO_RULES, true)).toBe("allow");
  });
});

describe("the declaration the model sees", () => {
  test("DreamNote is registered with the description and schema", () => {
    const definition = TOOL_DEFINITIONS.DreamNote;
    const payload = serializeFunctionOnlyToolPayload(
      "DreamNote",
      definition.modelForm,
    );
    expect(definition.modelForm.type).toBe("function");
    expect(payload.name).toBe("DreamNote");
    expect(payload.description).toContain("next dream run");
    expect(payload.description).toContain("not a memory write");
    expect(payload.parameters.required).toEqual(["text"]);
    expect(payload.parameters.additionalProperties).toBe(false);
    const text = payload.parameters.properties?.text;
    expect(text?.maxLength).toBe(DREAM_NOTE_MAX_TEXT_CHARS);
    expect(payload.parameters.properties?.agent_id).toBeDefined();
  });
});
