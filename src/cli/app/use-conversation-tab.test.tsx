import { afterEach, describe, expect, test } from "bun:test";
import { Text } from "ink";
import { getOpenConversations, resetTabsForTests } from "@/cli/app/tabs";
import { useConversationTab } from "@/cli/app/use-conversation-tab";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";

/**
 * The tab store's one writer.
 *
 * The case that matters is the **placeholder**: the process entry renders the app
 * with `conversationId: "loading"` while it resolves the session (`index.ts`), so
 * this hook is handed a value that is not a conversation. Recording it opened a
 * real tab titled `loading`, and any switch to it — a click, a `/close` handing
 * focus on — persisted `conversationId: "loading"` as the session. The next start
 * then failed to resume it ("Conversation loading not found").
 */
function Harness({
  conversationId,
  summary = null,
  streaming = false,
}: {
  conversationId: string;
  summary?: string | null;
  streaming?: boolean;
}) {
  useConversationTab({ conversationId, summary, streaming });
  return <Text>{conversationId}</Text>;
}

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  resetTabsForTests();
  resetInkTtyState();
});

describe("the tab store and the loading placeholder", () => {
  test("the placeholder opens no tab", async () => {
    const tty = mountInkTty(<Harness conversationId="loading" />, {
      columns: 40,
      rows: 10,
    });
    try {
      await settle();
      expect(getOpenConversations()).toEqual([]);
    } finally {
      tty.stop();
    }
  });

  test("a real conversation opens its tab and focuses it", async () => {
    const tty = mountInkTty(
      <Harness conversationId="local-conv-1" summary="M6 shell" />,
      { columns: 40, rows: 10 },
    );
    try {
      await settle();
      expect(getOpenConversations().map((tab) => tab.id)).toEqual([
        "local-conv-1",
      ]);
    } finally {
      tty.stop();
    }
  });

  test("a streaming placeholder does not focus a tab into existence", async () => {
    const tty = mountInkTty(<Harness conversationId="loading" streaming />, {
      columns: 40,
      rows: 10,
    });
    try {
      await settle();
      expect(getOpenConversations()).toEqual([]);
    } finally {
      tty.stop();
    }
  });
});
