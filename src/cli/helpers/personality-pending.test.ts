import { describe, expect, test } from "bun:test";
import { formatPersonalitySwappedMessage } from "@/cli/helpers/personality-pending";

describe("formatPersonalitySwappedMessage", () => {
  test("names the new personality", () => {
    expect(formatPersonalitySwappedMessage("Coach")).toContain(
      "Personality swapped to Coach",
    );
  });

  test("says the change is registered but not applied", () => {
    const message = formatPersonalitySwappedMessage("Coach");
    expect(message).toContain("registered but not applied");
    expect(message).toContain("/context pending");
    expect(message).toContain("/recompile");
  });

  test("never claims the personality is already in effect", () => {
    // R-08: the old wording promised the flavour of an immediate recompile.
    const message = formatPersonalitySwappedMessage("Coach");
    expect(message).not.toContain("take full effect");
    expect(message).not.toContain("Recompiling");
  });
});
