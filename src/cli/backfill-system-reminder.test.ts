import { describe, expect, test } from "bun:test";
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import { createBuffers } from "@/cli/helpers/accumulator";
import { backfillBuffers } from "@/cli/helpers/backfill";
import {
  SYSTEM_ALERT_CLOSE,
  SYSTEM_ALERT_OPEN,
  SYSTEM_REMINDER_CLOSE,
  SYSTEM_REMINDER_OPEN,
} from "@/constants";

function userMessage(
  id: string,
  content: string | Array<{ type: "text"; text: string }>,
): Message {
  return {
    id,
    message_type: "user_message",
    content,
  } as unknown as Message;
}

describe("backfill system-reminder handling", () => {
  test("hides pure system-reminder content parts", () => {
    const buffers = createBuffers();
    const history = [
      userMessage("u1", [
        {
          type: "text",
          text: `${SYSTEM_REMINDER_OPEN}\nInjected context\n${SYSTEM_REMINDER_CLOSE}`,
        },
        { type: "text", text: "Real user message" },
      ]),
    ];

    backfillBuffers(buffers, history);

    const line = buffers.byId.get("u1");
    expect(line?.kind).toBe("user");
    expect(line && "text" in line ? line.text : "").toBe("Real user message");
  });

  test("removes system-reminder blocks from string content while preserving user text", () => {
    const buffers = createBuffers();
    const history = [
      userMessage(
        "u2",
        `${SYSTEM_REMINDER_OPEN}\nInjected context\n${SYSTEM_REMINDER_CLOSE}\n\nKeep this text`,
      ),
    ];

    backfillBuffers(buffers, history);

    const line = buffers.byId.get("u2");
    expect(line?.kind).toBe("user");
    expect(line && "text" in line ? line.text : "").toBe("Keep this text");
  });

  test("drops user rows that are only system-reminder content", () => {
    const buffers = createBuffers();
    const history = [
      userMessage(
        "u3",
        `${SYSTEM_REMINDER_OPEN}\nInjected context\n${SYSTEM_REMINDER_CLOSE}`,
      ),
    ];

    backfillBuffers(buffers, history);

    expect(buffers.byId.get("u3")).toBeUndefined();
    expect(buffers.order).toHaveLength(0);
  });

  test("hides legacy system-alert blocks from backfill", () => {
    const buffers = createBuffers();
    const history = [
      userMessage(
        "u4",
        `${SYSTEM_ALERT_OPEN}The user interrupted the active stream.${SYSTEM_ALERT_CLOSE}\n\nhello :D`,
      ),
    ];

    backfillBuffers(buffers, history);

    const line = buffers.byId.get("u4");
    expect(line?.kind).toBe("user");
    expect(line && "text" in line ? line.text : "").toBe("hello :D");
  });

  test("hides injected skill content from backfill", () => {
    const buffers = createBuffers();
    const history = [
      userMessage(
        "u5",
        '<skill_content name="review-pr">\n---\ndescription: Review a PR\n---\nInstructions\n</skill_content>',
      ),
    ];

    backfillBuffers(buffers, history);

    expect(buffers.byId.get("u5")).toBeUndefined();
    expect(buffers.order).toHaveLength(0);
  });

  test("preserves user text alongside injected skill content in backfill", () => {
    const buffers = createBuffers();
    const history = [
      userMessage("u6", [
        {
          type: "text",
          text: '<skill_content name="review-pr">Instructions</skill_content>',
        },
        { type: "text", text: "Review PR 123" },
      ]),
    ];

    backfillBuffers(buffers, history);

    expect(buffers.byId.get("u6")).toMatchObject({
      kind: "user",
      text: "Review PR 123",
    });
  });

  test("keeps a recall block whole when it quotes a background-task notification", () => {
    // The restored transcript used to turn this message into an event row plus the
    // raw reminder text: the notification extractor read *inside* the quoted
    // passage and removed from there to the end of the message — the closing
    // reminder tag and the user's own prose included. That is the "user message
    // became unexpected content after a restart" report (2026-10-24).
    const buffers = createBuffers();
    const quoted = `${SYSTEM_REMINDER_OPEN}
<recall-injected items="1" transcript="1" memory="0" />
[1] transcript · conversation abc · message ui-msg-1 · 2026-10-16T15:09:25.856Z
user: <task-notification>
<task-id>bash_25</task-id>
<status>completed</status>
<summary>Background command "Run the comparison" completed</summary>
<result>$ run --output=...
${SYSTEM_REMINDER_CLOSE}`;
    const history = [
      userMessage("u7", [
        { type: "text", text: quoted },
        { type: "text", text: "夜深了，晚安。" },
      ]),
    ];

    backfillBuffers(buffers, history);

    const line = buffers.byId.get("u7");
    expect(line?.kind).toBe("user");
    const text = line && "text" in line ? line.text : "";
    // The quoted notification is history, not an event of this conversation.
    expect(
      [...buffers.byId.values()].some((entry) => entry.kind === "event"),
    ).toBe(false);
    // The block survives whole (its closing tag is what the renderer needs to
    // classify it as a recall block), and the prose after it is still there.
    expect(text).toContain(`${SYSTEM_REMINDER_CLOSE}`);
    expect(text).toContain("夜深了，晚安。");
    expect(text).toStartWith(SYSTEM_REMINDER_OPEN);
  });
});
