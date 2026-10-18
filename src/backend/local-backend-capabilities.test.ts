import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HEADLESS_BACKEND_CAPABILITIES } from "@/backend/dev/fake-headless-backend";

/**
 * The premise two deletion batches rest on (B9 #6, B9 #7).
 *
 * The GitHub App installer route opened only when
 * `getBackend().capabilities.localModelCatalog` was false, and the startup
 * picker offered a model list only when the custom-API inventory was
 * non-empty. Both were deleted as unreachable, and that holds only while every
 * backend this process can build reports `localModelCatalog: true`.
 *
 * `getBackend()` constructs `LocalBackend` and nothing else, and that class
 * builds its capability set by spreading the shared one, so the two assertions
 * below are the tripwire: if a backend reporting `false` is reintroduced, the
 * deleted paths have to come back with it.
 */
function readSource(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    "utf-8",
  );
}

describe("the one backend owns its model catalog", () => {
  test("the shared capability set reports the local catalog", () => {
    expect(HEADLESS_BACKEND_CAPABILITIES.localModelCatalog).toBe(true);
  });

  test("the only backend class adds capabilities without taking that one away", () => {
    const source = readSource("./local/local-backend.ts");

    expect(source).toContain("...HEADLESS_BACKEND_CAPABILITIES");
    // Mentioning it at all would mean overriding it, which is the one way a
    // backend could report `false` while still spreading the shared set.
    expect(source).not.toContain("localModelCatalog");
  });
});
