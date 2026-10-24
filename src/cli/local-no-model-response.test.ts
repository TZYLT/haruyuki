import { describe, expect, test } from "bun:test";
import {
  buildLocalNoModelResponse,
  splitSyntheticAssistantResponse,
} from "@/cli/helpers/local-no-model-response";

describe("local no-model synthetic response", () => {
  test("points at /config connect and an env key, and nothing else", () => {
    const message = buildLocalNoModelResponse();
    expect(message).toContain("/config connect");
    expect(message).toContain("export OPENAI_API_KEY=...");
    // `/login` is gone, so no copy may still send the user there.
    expect(message).not.toContain("/login");
    expect(message).not.toContain("Letta Cloud");
  });

  test("synthetic streaming chunks preserve line breaks", () => {
    expect(splitSyntheticAssistantResponse("hi\n\nthere")).toEqual([
      "hi",
      "\n",
      "\n",
      "there",
    ]);
  });
});
