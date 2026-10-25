import { test } from "bun:test";

// M5 fills this file: --dry-run entry count equals the real package, a failed
// export removes .partial, an existing target is overwritten, and excluded
// paths never enter the package.
test.todo("export: pipeline + .partial cleanup (M5)", () => {});
