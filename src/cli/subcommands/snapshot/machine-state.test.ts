import { test } from "bun:test";

// M3 fills this file: cron lease clearing (corrupt JSON must error, not silently
// clear), git lock and helper removal, idempotent hook reinstall, and coverage
// of both memfs/*/memory and agents/*/memory.
test.todo("machine-state: cron lease + locks + hooks (M3)", () => {});
