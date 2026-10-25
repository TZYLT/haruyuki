import { test } from "bun:test";

// M3 fills this file: the three partitions, settings sanitization (package copy
// only, source untouched), the keychain-unavailable file fallback, per-item
// write failures not aborting, and output that never contains a value.
test.todo("secrets: collect + apply + sanitize (M3)", () => {});
