import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The toolkit's first rule, as a check rather than a convention: **one key
 * owner** (`overlay/README.md` rule 1). Inside `overlay`/`modal`, an overlay
 * declares its keys through the router — `useOverlayList` for a list, a
 * `useKeyBindings` table for anything else — never through Ink's `useInput`,
 * which fans one event out to every listener and cannot be told "this key is
 * mine".
 *
 * Behaviour cannot see this: a face with its own `useInput` can still paint the
 * right frame in a test that drives only that face. What it cannot survive is
 * being mounted next to anything else that reads keys — which is the app.
 *
 * It is also not only about which listener wins. Migrating `/hooks` measured the
 * same freeze `ApprovalOptions.test.tsx` records: under React 19.2.8 with
 * `react-reconciler` 0.33.0 (Ink 7.1.1) a **`memo`-wrapped component's
 * `useInput` handler keeps the state of its first render**. A counter
 * incremented from that handler reads `[0,0,0]` behind `memo` and `[0,1,2]`
 * without it, and the old `/hooks` face logs `screen=events index=0` on every
 * dispatch, so under a bare mount its ladder never leaves the root step — while
 * the same file with `memo(` removed walks all six screens. A face that reads
 * its own state inside `useInput` is reading a stale one, and the router's
 * tables are read at event time instead.
 *
 * The list is the faces this batch migrated. It grows as the later batches land,
 * and a face is added here in the commit that removes its handler.
 */
const MIGRATED_FACES = [
  "components/AgentSelector.tsx",
  "components/CompactionSelector.tsx",
  "components/ConversationSelector.tsx",
  "components/FeedbackDialog.tsx",
  "components/HooksManager.tsx",
  "components/McpSelector.tsx",
  "components/MessageSearch.tsx",
  "components/ModelReasoningSelector.tsx",
  "components/PinDialog.tsx",
  "components/ProviderSelector.tsx",
  "components/RecallOverlay.tsx",
  "components/SkillsDialog.tsx",
  "components/SleeptimeSelector.tsx",
  "components/TopicSelector.tsx",
  "components/WorktreeDiffSelector.tsx",
  "components/WindowTitlePicker.tsx",
  // Not a component: the autocomplete popup's shared navigation hook. It sits in
  // the composer's own scope, but the rule is the same one, and the hook is
  // where ↑/↓ used to be read from a stale first render.
  "hooks/use-autocomplete-navigation.ts",
  // And the first-run picker, which lives directly under `cli/`.
  "profile-selection.tsx",
];

describe("one key owner", () => {
  for (const face of MIGRATED_FACES) {
    test(`${face} binds no keys of its own`, () => {
      const path = fileURLToPath(new URL(`../${face}`, import.meta.url));
      const source = readFileSync(path, "utf-8");

      expect(source).not.toContain("useInput(");
    });
  }
});
