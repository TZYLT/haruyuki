import { describe, expect, test } from "bun:test";
import {
  DISABLE_LOCAL_MODEL_DISCOVERY_ENV,
  localModelDiscoveryDisabled,
} from "./pi-provider-registry";

// The gate exists so a test never inherits the machine's model layer. Only an
// explicit `1` turns it on: a typo or an `=0` must leave discovery alone rather
// than silently change what a run can reach.
describe("local model discovery gate", () => {
  test("is off unless the flag is exactly 1", () => {
    expect(localModelDiscoveryDisabled({})).toBe(false);
    expect(
      localModelDiscoveryDisabled({ [DISABLE_LOCAL_MODEL_DISCOVERY_ENV]: "0" }),
    ).toBe(false);
    expect(
      localModelDiscoveryDisabled({
        [DISABLE_LOCAL_MODEL_DISCOVERY_ENV]: "true",
      }),
    ).toBe(false);
    expect(
      localModelDiscoveryDisabled({ [DISABLE_LOCAL_MODEL_DISCOVERY_ENV]: "" }),
    ).toBe(false);
    expect(
      localModelDiscoveryDisabled({ [DISABLE_LOCAL_MODEL_DISCOVERY_ENV]: "1" }),
    ).toBe(true);
  });

  test("reads the environment it is given, not the ambient one", () => {
    const previous = process.env[DISABLE_LOCAL_MODEL_DISCOVERY_ENV];
    process.env[DISABLE_LOCAL_MODEL_DISCOVERY_ENV] = "1";
    try {
      expect(localModelDiscoveryDisabled()).toBe(true);
      expect(localModelDiscoveryDisabled({})).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env[DISABLE_LOCAL_MODEL_DISCOVERY_ENV];
      } else {
        process.env[DISABLE_LOCAL_MODEL_DISCOVERY_ENV] = previous;
      }
    }
  });
});
