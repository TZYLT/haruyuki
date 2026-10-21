# Haruyuki — Agent Guide

This file explains how to work effectively in this repo. It covers the rules enforced by the local check suite (`bun run check`) and the pre-commit hook, **why each rule exists**, and the workflow conventions that keep the codebase healthy and agent-navigable.

**This fork runs no CI, on purpose.** `.github/` carries governance files only (issue and PR
templates); there is no workflow. The pre-commit hook and `bun run check` are the gates, plus the
release preflight. The reasons are recorded in `CONTRIBUTING.md` §G — briefly: this is a
single-maintainer fork whose default workflow is committing (including WIP) straight to `main`,
so a `push`-triggered workflow would sit red most of the time, which is worse than having none.
Do not add a workflow without re-opening that decision.

To check what a **fresh clone** sees (the one thing CI would have added), run from an empty temp
directory: `git clone <repo-url> clone && cd clone && bun install --frozen-lockfile && bun run check`.

---

## Workflow

1. **Create a worktree** for any non-trivial change — especially if another agent may be working concurrently.
2. **Make your change**, then run `bun run check` and fix all failures before opening a PR.
3. **One PR per logical change.** Don't bundle unrelated changes — harder to revert if something breaks.
4. **Never amend commits.** Always create a new commit.
5. **Check the current branch** before editing files. If in doubt, ask.

---

## Runtime Validation

### Automated notifications use user-role reminders

Never inject `role: "system"` messages into conversation history for harness
notifications, recovery, teleport, onboarding, or mod instructions. Use
`role: "user"` with `<system-reminder>...</system-reminder>` content instead.
The tags identify automated context without requiring API-level system priority;
the existing transcript echo strips reminder-only content from user bubbles.
Anthropic can reject a system-role notification after an ordinary assistant
message, including when a later user message follows it. Keep tool results before
the reminder and preserve message IDs. This rule does not change the compiled
system prompt or explicit user-supplied provider/API message roles.

Development and distribution use different runtimes. `bun run dev` runs the
TypeScript source with Bun, while the published package exposes a Node-targeted
`haruyuki.js` bundle and requires Node 22.19 or newer. When behavior depends on the
runtime, test both the Bun source path and the built Node artifact.

The interactive TUI, headless mode, and websocket listener also have separate
orchestration paths. Changes to shared turn, tool, approval, permission, or
transcript behavior must identify and run the focused tests for every affected
path. `bun run check` is always required, but it does not replace those behavior
tests.

---

## Rules and Why They Exist

These are the rules enforced by `bun run check` and the pre-commit hook, with the reasoning behind each. Understanding the *why* lets you make good decisions in ambiguous cases the rules don't explicitly cover.

### No `../` parent imports — use `@/`

**Rule:** All cross-directory imports must use the `@/` alias (`@/` maps to `src/`). Relative parent paths (`../`) are banned and blocked by pre-commit.

**Why:** Agents navigate codebases by searching. `import { getBackend } from "@/backend"` is immediately grep-discoverable anywhere in the repo. `import { getBackend } from "../../backend"` requires resolving the path from the current file's location — fragile to moves and opaque to search. Consistent absolute paths also make codemods reliable: a rename script can find all import sites with a simple grep.

```ts
// correct
import { getBackend } from "@/backend";
import { isDebugEnabled } from "@/utils/debug";

// wrong — blocked by pre-commit hook
import { getBackend } from "../../backend";
```

**The hook exempts `package.json` only.** That file legitimately lives above `src/` and is matched by grep for a file-name mention; every other file must use `@/`. No `src/` file is exempt, and no tracked `.ts`/`.tsx` file outside `src/` currently needs one (there are six, and none uses a parent-relative import). Same-directory `./` imports are always fine.

---

### Kebab-case `.ts` filenames, PascalCase `.tsx`

**Rule:** `.ts` source files use kebab-case (`local-store.ts`). `.tsx` component files use PascalCase (`AgentSelector.tsx`). Enforced by `scripts/check-filename-casing.js` in pre-commit and `bun run check`.

**Why:** Agents evaluate code quality by how searchable a codebase is. Inconsistent casing (`localStore.ts`, `LocalStore.ts`, `local-store.ts`) means a grep pattern that works for one file fails for another. macOS's case-insensitive filesystem makes this worse — `existsSync("bash.ts")` returns `true` when `Bash.ts` exists, silently breaking rename scripts. Kebab-case `.ts` is also consistent with how Node/Bun resolves modules on a case-sensitive filesystem.

---

### Named exports everywhere — no default exports

**Rule:** All exports must be named. Default exports are banned (`style/noDefaultExport` biome rule).

**Why:** `grep 'export function AgentSelector'` finds the definition in one shot. With a default export, `export default function` tells you nothing about what the consumer will call it — each import site can rename it arbitrarily, making codebase-wide search unreliable.

---

### `export function` over `export const fn = () =>`

**Rule:** Exported functions must use the `export function` declaration form. `export const fn = () =>` is flagged by `scripts/check-exported-functions.js`. Exception: `.tsx` files wrapping `React.memo()`.

**Why:** Same grep-discoverability principle. `grep 'export function foo'` finds every exported function definition in one query. `export const` mixes function declarations with value exports — agents can't distinguish them without reading the right-hand side. `export function` is also hoisted, making it order-independent.

```ts
// correct
export function computeThing(x: string): number { ... }

// wrong — flagged by check-exported-functions.js
export const computeThing = (x: string): number => { ... }
```

---

### No circular dependencies

**Rule:** Zero circular imports. Enforced by madge (`check:cycles`) in pre-commit and `bun run check`. The current baseline is exactly 0.

**Why:** Circular imports cause subtle initialization-order bugs (module A's top-level code runs before module B has finished initializing, even though A imports from B). They also make the dependency graph impossible to reason about — you can't understand a file in isolation if its transitive dependencies loop back to it. The layer map below only has meaning if the graph is acyclic.

---

### Source files stay below 1,000 lines

**Rule:** New source and test files must not exceed 1,000 lines. Existing
oversized files are pinned in `scripts/source-file-size-baseline.json`: they may
shrink, but they may not grow. Lower the baseline in the same change whenever an
oversized file gets smaller, and remove its entry once it reaches the limit.

**Why:** Agents commonly inspect large files in slices and miss distant state,
cleanup, or fallback paths. Responsibility-sized modules make the whole behavior
readable in one pass and give tests an obvious home.

---

### Import from the owner, not an implementation barrel

**Rule:** Import a symbol from the module that defines it. Do not turn concrete
implementation entrypoints such as channel adapters into convenience barrels.
Scoped ownership rules are enforced by `scripts/check-module-ownership.js`.

**Why:** Forwarding exports hide where behavior lives, inflate dependency graphs,
and make agents open orchestration files when they need a small helper. Public
package entrypoints may still re-export their intentional API surface.

---

### Layer boundaries — no upward imports

**Rule:** Files may only import from the same layer or layers below them. Violations are caught by `scripts/check-layer-boundaries.js` in pre-commit and `bun run check`.

**Why:** Coupling a lower layer to a higher layer collapses the abstraction. If `backend/` imports from `cli/`, you can no longer use the backend without the UI — tests become harder to write, and changes to the UI risk breaking storage logic. The boundary rules make each layer independently testable and make it safe to change or swap implementations.

```
cli/           ← Ink UI, commands, overlays
websocket/     ← WS listener, session management
usage/         ← per-turn usage ledger (numbers only) + aggregation
agent/         ← domain: conversation, approval, context
tools/         ← tool implementations
backend/       ← API/storage abstraction
providers/     ← LLM adapters (Anthropic, OpenAI)
permissions/   ← pure permission rules (no UI deps)
telemetry/     ← leaf: observability
cron/          ← leaf: scheduler
channels/      ← leaf: integrations
utils/         ← bottom: no domain deps
```

**Enforced rules:**
- `tools/` cannot import from `cli/`
- `backend/` cannot import from `cli/` or `websocket/`
- `providers/` cannot import from `agent/` or `cli/`
- `websocket/listener/` cannot import `backend/api/client` or `backend/api/conversations` directly
- `cli/app/` cannot import `backend/api/conversations` directly
- `usage/` cannot import `cli/` or `websocket/`

**When adding a new file:** put it in the lowest layer whose dependencies it needs. If you find yourself importing from a higher layer, extract the shared logic into a lower one instead.

---

### Unused locals and parameters are errors

**Rule:** `noUnusedLocals` and `noUnusedParameters` are enabled in `tsconfig.json`. `tsc --noEmit` runs on every commit.

**Why:** Unused symbols mislead agents into thinking something is needed when it isn't. Dead code is the most common source of incorrect assumptions when exploring an unfamiliar codebase. Keeping the signal-to-noise ratio high makes grep results meaningful.

- Use `_prefix` for intentionally unused parameters (`_event`, `_index`).
- Use `void x` to discard a value without creating a binding.
- TypeScript exempts `_`-prefixed names from the check, but NOT function declarations (`function _foo()` is still flagged — use `void` instead).

---

### Test mock isolation

**Rule:** `mock.module()` calls must follow isolation patterns checked by `scripts/check-test-mock-isolation.js`.

**Why:** In Bun, `mock.module()` is applied to the **global module registry** of the worker process — not scoped to the current test file. Mocks leak to all other test files running in the same worker. A mock set in `foo.test.ts` can silently affect `bar.test.ts` if they share a worker, even though `bar.test.ts` never asked for it. This produces failures that only appear in the full test suite, not in isolation.

Practical rules:
- Prefer dependency injection or object-level stubbing over module-level mocking.
- Don't mock broad shared modules (`settings-manager`, telemetry, etc.).
- If a test file must use `mock.module()`, register it with a reason in `scripts/isolated-unit-tests.json`; `scripts/run-unit-tests.cjs` will run it in a standalone Bun process, and the mock-isolation check rejects unregistered top-level mocks.
- If a test passes alone but fails in `bun test src/`, suspect mock leakage first.

---

## Directory Guides

Some directories carry their own binding `AGENTS.md` with rules that override
generic instincts. Read the local guide before changing code there:

- `src/cli/AGENTS.md` — Ink rendering, approvals, and interactive input rules
  for the TUI.
- `src/websocket/listener/AGENTS.md` — turn lifecycle, leases, approvals, queue
  gating, and where listener tests belong.
- `src/channels/AGENTS.md` — gateway policy placement and the pure-logic
  package subpaths shared with remote hosts.
- `src/channels/slack/AGENTS.md` — Slack module ownership, the progress
  contract, and live verification requirements.

---

## Placing New Files

| What you're adding | Where it goes |
|--------------------|---------------|
| Ink component (UI only) | `src/cli/components/` |
| Command handler | `src/cli/commands/` |
| Hook used in App | `src/cli/app/` or `src/cli/hooks/` |
| WS listener logic | `src/websocket/listener/` |
| Agent/conversation domain logic | `src/agent/` |
| Per-turn usage ledger / aggregation | `src/usage/` |
| Tool implementation | `src/tools/impl/` |
| Backend abstraction | `src/backend/` |
| LLM provider adapter | `src/providers/` |
| Pure utility (no domain deps) | `src/utils/` |
| Shared test helpers | `src/test-utils/` |
| Build/lint scripts | `scripts/` |

Test files live **next to their source** (`local-store.test.ts` next to `local-store.ts`), not in a separate `tests/` directory.

---

## Reference

### Commands

| Task | Command |
|------|---------|
| Install deps | `bun install` |
| Full check suite | `bun run check` |
| Auto-fix lint/format | `bun run fix` |
| Type check only | `bun run typecheck` |
| Run a single test file | `bun test src/path/to/file.test.ts` |
| Run all unit tests | `node scripts/run-unit-tests.cjs` (parallel; `HARUYUKI_TEST_PARALLEL=0` for the old serial run) |
| Dev mode | `bun run dev` (sets `HARUYUKI_DEBUG=1` by default) |

`bun run fix` only auto-fixes biome violations (format + lint autofixes). The
architectural checks and TypeScript errors need manual fixes. The pre-commit hook
also rejects staged parent-relative imports (`../`); use the `@/` alias.

**When you touch `scripts/run-unit-tests.cjs`, smoke-test
`HARUYUKI_TEST_PARALLEL=0` too.** The parallel batch and the serial escape hatch
are separate code paths, and a bug in the escape hatch shows up as *fewer tests
running with no failure* — exactly the shape that hid a skipped-suite bug until
review. The runner also refuses to report success when it selected nothing.

### Check Suite (what each check does)

1. **cycles** — `madge --circular src/`; must be exactly 0
2. **boundaries** — `scripts/check-layer-boundaries.js`; checks import direction per layer
3. **cloud-egress** — `scripts/check-cloud-egress.js`; production code must not import the modules that exist only to reach Letta Cloud (the forbidden list and the local exemptions each carry a reason in that file)
4. **exported-functions** — `scripts/check-exported-functions.js`; flags `export const fn =`
5. **filename-casing** — `scripts/check-filename-casing.js`; enforces source naming conventions
6. **source-file-size** — `scripts/check-source-file-size.js`; enforces the 1,000-line ceiling and ratchet
7. **module-ownership** — `scripts/check-module-ownership.js`; protects orchestration modules from barrel imports/exports
8. **recompile-callsites** — `scripts/check-recompile-callsites.js`; enforces the prefix-freeze application-point contract (who may rewrite a conversation's frozen prefix, and which freeze reasons are valid)
9. **test-mock-isolation** — `scripts/check-test-mock-isolation.js`; flags unsafe `mock.module` patterns
10. **test-coverage** — `scripts/check-test-coverage.cjs`; checks source/test coverage policy
11. **skill-frontmatter** — checks every `SKILL.md` has a non-empty `name:` header
12. **bundled-skill-scripts** — validates scripts shipped with bundled skills
13. **biome** — format + lint across source files
14. **typescript** — full `tsc --noEmit`

### Environment Variables

| Variable | Effect |
|----------|--------|
| `HARUYUKI_DEBUG=1` | Verbose debug output (default in `bun run dev`) |
| `HARUYUKI_DEBUG=0` | Suppress debug output even in dev mode |
| `HARUYUKI_MEMFS_BACKEND=hosted` | Opt into the hosted MemFS backend path instead of the local one (default is local) |
| `HARUYUKI_LOCAL_BACKEND_EXPERIMENTAL=1` | Namespace selector, not a backend toggle (there is only one backend): it picks the `local:<dir>` settings bucket and `<storageDir>/memfs/<agentId>/memory` as the agent memory root. `configureBackendMode("local")` sets it. Leaving it unset sends local pins, per-agent settings and memory files to the legacy `api.letta.com` namespace instead |
| `HARUYUKI_LOCAL_BACKEND_EXECUTOR=deterministic` | Use fake deterministic executor (for tests) |
| `LETTA_LOCAL_BACKEND_DIR` | Local-backend storage root (defaults to `~/.haruyuki/lc-local-backend`) |
| `HARUYUKI_HOME` | Overrides the harness root outright, in place of `~/.haruyuki` (every path that resolves through `src/utils/app-paths.ts`) |
| `HARUYUKI_PREFIX_PROBE_DIR` | Dump each local provider request payload to `payload-<conversationId>-<seq>.json` for the prefix-freeze probe (default off) |
| `HARUYUKI_TEST_PARALLEL` | Worker count for `node scripts/run-unit-tests.cjs` (default 16, capped at the core count). `0` restores the old chunked, single-process serial run |
| `HARUYUKI_AMBIGUOUS_WIDTH` | `auto\|narrow\|wide`: how many columns this terminal draws Unicode's *ambiguous* characters (`— … ≥ → ·`). `auto` (default) asks the terminal; see `src/cli/helpers/char-width.ts`. A pinned value beats the settings file, which beats the probe |
| `HARUYUKI_AMBIGUOUS_WIDTH_PROBE=0` | Skip the startup probe and keep the width table's own answer (narrow) |

**Eight names still carry the `LETTA_` prefix, deliberately.** The env prefix
was renamed to `HARUYUKI_`, but `@letta-ai/letta-agent-sdk` — loaded at runtime
by the Workflow tool — reads these itself, and `node_modules` cannot be edited
(a reinstall reverts it). Renaming only our side makes the SDK silently fall
back to its own bundled `@letta-ai/letta-code` (`LETTA_CLI_PATH` unset) and
compute memory-confinement writable roots from stale names
(`LETTA_LOCAL_BACKEND_DIR`, `LETTA_MEMORY_DIR`, `LETTA_TRANSCRIPT_ROOT`), which
is the same silent-divergence class the `.haruyuki` rename had to fix:

`LETTA_CLI_PATH` · `LETTA_LOCAL_BACKEND_DIR` · `LETTA_MEMORY_DIR` ·
`LETTA_TRANSCRIPT_ROOT` · `LETTA_SANDBOX` · `LETTA_API_KEY` ·
`LETTA_BASE_URL` · `LETTA_LOG`

Do not rename these to match the new prefix. The freeze is lifted in a
follow-up once that dependency is removed; the per-name read coordinates are
recorded in `CONTRIBUTING.md` §C and `THIRD-PARTY-NOTICES.md` §5.

When manually smoke-testing the local backend (`haruyuki --backend local` or
`bun run dev --backend local`), set `LETTA_LOCAL_BACKEND_DIR` to a temporary
directory first. Otherwise the run reads and mutates your real
`~/.haruyuki/lc-local-backend` provider, auth, and transcript state.

### Known Gotchas

- **Prettier is not used.** Biome is the sole formatter. Do not add Prettier — they conflict.
- **`new URL("./path.ts", import.meta.url)` in tests** is not a static import and is not caught by the `@/` import codemod. Scan for `new URL(` manually when moving source files.
- **grep exits 1 on no matches** — pre-commit hooks use `|| true` on grep pipes to prevent false failures on clean commits.
- **macOS case-insensitive FS** — `existsSync("bash.ts")` returns `true` when `Bash.ts` exists. Rename scripts that use `existsSync` to check kebab-case targets will silently skip single-word PascalCase files. Use `git mv` for renames.
- **Native modules can behave differently under Bun and Node.** The published package runs the bundled `haruyuki.js` under Node (>= 22.19), while `bun run dev` runs the source under Bun. Example: `node-pty` is loaded directly under Node but through a Node bridge process under Bun, because its native handles do not integrate reliably with Bun's event loop (`src/tools/impl/shell-runner.ts`). Test runtime-sensitive code on both paths.
- **`bun run build` used to inline `__dirname` for bundled CommonJS deps.** Bun wraps an inlined CommonJS dependency in `__commonJS`, which bakes `__dirname`/`__filename` as the **build machine's** absolute path: `haruyuki@0.2.0` shipped `var __dirname = "<build machine>/node_modules/typescript/lib"` that way. There is no declarative switch — `define` is ignored for that generated shim and `root` only affects multi-entry naming (both verified). `typescript` is therefore `external` and a runtime `dependency` rather than inlined; the published CLI genuinely needs it because the mod engine calls `ts.transpileModule` (`src/mods/mod-engine.ts:460`). Cost of that choice: the install grows by roughly +14 MiB unpacked / +2.75 MiB on the wire, which README discloses. `scripts/check-build-leaks.mjs` — run by `release.mjs` and by CI — fails the release if a build-machine path reappears in any packed file.
- **`files` beats `.npmignore` and `.gitignore`, and supports `!` exclusions.** A file inside a whitelisted *directory* is packed even when git ignores it (verified: neither ignore file removes it). `scripts/.haruyuki/settings.local.json` — carrying the maintainer's home path and local agent/conversation ids — was in the pack list until `package.json` `files` gained `"!scripts/.haruyuki"`. Anything that drops local state under `scripts/`, `docs/examples/`, `skills/`, `vendor/` or `assets/` leaks into the tarball, so keep the exclusion entries and let `check-build-leaks.mjs` stay the net.
- **`setTimeout(fn, 0)` fires on the next tick, not never.** For "no timeout" behavior, check the timeout value before scheduling the timer instead of passing 0.
- **Extend `@letta-ai/letta-client` types instead of redeclaring them.** Use the SDK's `ToolCall`, `StopReasonType`, and similar wire types directly; do not duplicate wire shapes or cast with `as any`.
- **Package subpath entrypoints use relative imports and dedicated entry files.** Library entries (`src/agent-presets.ts`, `src/channels-*.ts`, `src/app-server-client.ts`) are bundled separately and their emitted `.d.ts` files go through an alias rewrite in `build.js`; anything reachable from a browser-targeted entry must stay free of node builtins and backend/provider imports. Consumers on `moduleResolution: "node"` resolve subpath types through `typesVersions` in `package.json`, so new subpaths need entries there too.
- **When changing a function from swallowing errors to throwing**, check every caller; each may need different handling.

- **Headless does not reuse the TUI approval loop.** `src/headless.ts` has its
  own approval handling (it imports `classifyApprovals` rather than routing
  through the TUI's `ApprovalSwitch`). A change to streaming, approval or queue
  behaviour in `AppCoordinator`/`AppView` usually needs a matching change here;
  `src/cli/AGENTS.md` covers the TUI side of that contract.
- **`protocol_v2.ts` is the contract other clients compile against.** Consumers
  resolve its types through the `./app-server-protocol` and `./protocol` package
  subpaths, so a change is breaking unless it is purely additive. Remember
  `typesVersions` in `package.json` when adding a subpath.
- **OTID workaround.** `src/agent/check-approval.ts` and
  `src/agent/approval-recovery.ts` key approvals on `otid` when one is present,
  because the backend can reuse a single OTID across variants in one step. Keep
  the `otid:`-prefixed key shape; dropping it makes approval resync match the
  wrong message.
- **Agent-adapter mod import cache sharing.** Agent adapters share the default
  mod import cache. Two agents loading the same mod code share top-level module
  state. Per-agent isolation doesn't extend to mod-level mutable state.
- **`/reload` does not reload app TypeScript source.** Only re-reads mods and
  settings. Changes to app TypeScript files require a full process restart.
  New slash commands added to the registry also require a full restart.
- **`settingsManager` is a global singleton in tests.** State persists between
  tests. Tests that use it must call `await settingsManager.reset()` and
  `await settingsManager.initialize()` before running. Redirect `HOME` to a
  temp dir before `initialize()` to avoid reading the user's actual settings.
- **The Biome version is pinned in two places.** The `package.json` scripts and
  the `lint-staged` config both spell `@biomejs/biome@2.2.5`. Bump them together,
  or the pre-commit hook and `bun run check` can disagree about formatting.
- **`bun.lock` churn.** Running `bun install` in a worktree may add
  `"configVersion": 0` due to a newer Bun version. Scrub with `git checkout
  main -- bun.lock` when the PR has no real package.json change.
- **No desktop app lives in this repo.** `.github/`, `apps/`, `nx-electron`, the
  `justfile` and the remote-log-tree logic were removed at the split (commit
  `4fe26381`). This repo ships the CLI and a local app-server protocol that
  compatible clients consume; do not reintroduce desktop build steps here.
- **Harness paths come from `src/utils/app-paths.ts`.** Never spell `.haruyuki` (or
  a path under it) as a literal in new code. Use `appHomeRoot()` for the harness
  root, `appHomePath([APP_SUBDIRS.x, ...])` for a path inside it,
  `projectAppHomePath(cwd, ...)` for the project-level `<repo>/.haruyuki/...`, and
  `appHomeDirName()` for the few places that need the name as a path *segment*.
  `resolveHomeDir()` is the shared `HOME` → `USERPROFILE` → `os.homedir()`
  fallback.
  **`appHomeRoot` / `appHomePath` honour `HARUYUKI_HOME`, which overrides the root
  outright — `projectAppHomePath` deliberately does not.** It is the *user*-
  level root that moves; a project's `<repo>/.haruyuki/...` belongs to the
  project and must stay there. Passing a repo directory as `homeDir` to
  `appHomePath` silently redirects project settings, permission rules and
  managed worktrees to the relocated root — the reads and writes then disagree
  with no error. `HARUYUKI_HOME` is the one supported way tests and operators
  relocate user-level harness state. Regression coverage for the split lives in
  `src/permissions/harness-path-whitelists.test.ts`.
  **Never capture one of these helpers in a module-level `const`.** `HOME` and
  `HARUYUKI_HOME` are read when the path is asked for, so `export const X =
  appHomePath([...])` freezes whatever root happened to be current at import
  time — and then disagrees with every call-time resolver in the same process,
  with no error. Export a `getXDir()` function instead; `getGlobalSkillsDir()`
  and `getGlobalCommandsDir()` are the two that were converted.
  Call-time resolution is also why `appHomePath` takes a plain `homeDir` string
  rather than an `env`: pass `{ homeDir, env }` when a caller has its own
  environment (the sandbox policy does), and omit both to read the ambient one.
  A few files still carry the name as a literal. They are the **rename
  checklist** — touch them whenever the directory is renamed, and do not add
  yourself to it casually:
  - prose and examples: `src/tools/descriptions/*.md`,
    `src/agent/prompts/*.md`, and the `.md` code samples under
    `src/skills/builtin/`;
  - `src/mods/learning-harness.ts`'s `path.join(".haruyuki", "mod-learning-runs")`
    and its dev-script front-end `scripts/mod-learning/learn-mod.ts`'s `--out`
    help text — a working-tree scratch dir, and `learning-harness.ts` sits
    exactly at its size-ratchet cap, so it cannot take the extra import line;
  - `src/test-utils/startup-setup-pty-runner.cjs`'s `HARNESS_DIR_NAME` — a plain
    `.cjs` child process that cannot import the TS module.

  Nothing enforces this list, so grep the literal before you commit.
- **`*Rich.tsx` naming inversion.** Inside `src/cli/components/` the
  `*Rich.tsx` files are the ACTIVE message and input components, not the
  plain-named siblings. `InputRich.tsx` is the real input component and the
  source of `subagentLifecycleSnapshot`, so the product-status and subagent
  panels described below live there. Confirm the import site before assuming a
  `*Rich` file is unused.
- **`src/cli/app/App.tsx` is a re-export shim.** It is one line:
  `export { App } from "./AppCoordinator";`. TUI state lives in
  `AppCoordinator.tsx` (~4.5k lines, ~49 `useEffect`s). Do not edit `App.tsx`
  expecting behaviour there.
- **CLI glyph registry.** `src/cli/helpers/glyphs.ts` is the central registry
  for display glyphs. All components import from there.
- **Threading state through app subsystems.** When adding state that crosses
  subsystem boundaries, update ALL context types: `ConversationLoopContext`,
  `SubmitHandlerContext`, `ConversationSwitchingContext`. Missing one causes
  type error (missing definition) or runtime undefined (missing
  destructuring/prop-passing).
- **Settings manager 3-level precedence.** Global, project, local. When adding
  a new configurable setting, add the field to ALL THREE settings interfaces,
  add to project settings loading, and add collision routing in `updateSettings`.

---

## Code Review Signals

When reviewing PRs (yours or others'), watch for these patterns. They are the
most common sources of bugs in this codebase.

### TUI Flicker (most common bug)

`AppCoordinator.tsx` has ~49 `useEffect` calls and spread state (reached
through the `App.tsx` re-export). Adding any `useState` or `useReducer` that
updates on keystroke, timer tick, or streaming chunk triggers re-renders across
the entire component tree.

- **Do:** Use refs for values that don't need to trigger renders. Use
  `React.memo()` for static content. Keep state minimal.
- **Don't:** Add `useState`/`useReducer` for UI features that update on every
  keystroke, timer tick, or streaming chunk.
- **Debug:** `HARUYUKI_DEBUG_FLICKER=1` logs re-render triggers to file.
- **Review signal:** any PR adding state to `AppCoordinator.tsx` or
  `AppView.tsx`, modifying `useEffect` deps, or touching approval/rendering
  components.

### Ink `<Static>` and Double-Printing

Ink's `<Static>` writes to stdout and never erases. Changing the component key
re-mounts and re-renders all items, but previously rendered items persist on
screen, causing duplicate/triple output.

- Do not change the `<Static>` key unless items are already empty.
- Do not render the same output through both buffers (`commandRunner`) and
  `setStaticItems`.
- The accepted exception is an intentional transcript repaint on a display
  toggle: clear the screen first (`CLEAR_SCREEN_AND_HOME`), or rely on Ink's own
  `<Static>`-identity reset (`handleStaticChange` clears the retained static
  output before the new instance renders). A key change without either is a
  double-print risk.

### Tool Call Desync

Two separate accumulation paths (UI buffers vs `StreamProcessor`) for tool call
data can desync. `queuedApprovalResults` not cleared after send -> stale results
resent. Interrupt handler marking tools cancelled even when execution completed.

- **Review signal:** any PR touching approval flow, tool execution, or
  interrupt handling.

### Shell Tool Parity Gap

Policy/UI layer treats both shell tools (`Bash`, `exec_command`) identically,
but the implementations differ (`impl/bash.ts` vs `impl/exec-command.ts`).
Features added to one may be missing from the other.

- **Review signal:** any shell tool change, check both tools have parity.

### Interrupt Lock / State Cleanup

`EAGER_CANCEL` path and non-EAGER fallback BOTH need to clear ALL state flags
(`isExecutingTool`, `abortControllerRef`, `toolResultsInFlightRef`). Missing
one = permanently busy.

- **Review signal:** interrupt handling, ESC key, tool execution cleanup paths.

### Impossible-State PRs

When a PR addresses a corrupted/impossible state (e.g. `isProcessing=true` but
`loopStatus=WAITING_ON_INPUT`), the fix must trace and fix the **producer**,
the code path that creates the bad state. Teaching the consumer to tolerate
corrupted state is a workaround, not a fix.

**Red flags:**
1. Self-heal guard / state normalizer as primary correctness mechanism (a
   function that checks for an "impossible" state and silently fixes it).
   Acceptable as defense-in-depth + telemetry, but NEVER as the primary fix.
2. Tests that hand-construct the bad state (manually setting contradictory flags)
   only prove the recovery code works, they don't prove the production path is
   fixed.
3. PR description says "exact trigger not proven" or "likely event chain is..."
   , the fix is speculative.
4. Boolean terminal outcomes shared across cleanup layers, use a
   discriminated result (`continue | completed | interrupted | error`) instead.

### pi-ai Ownership Boundary

Haruyuki depends on `@earendil-works/pi-ai` specifically so that pi-ai owns:
provider payload conversion, model capability enforcement (e.g. downgrading
image parts for text-only models), the model catalog, and env key resolution.

LC's responsibility ends at a narrow seam: guarantee that only canonical,
type-valid `LocalMessage` content enters the pi Context (ingestion sanitizers in
`local-store.ts`, `toPiMessage`/`toPiMessages` in `pi-stream-adapter.ts`).

**Any PR that adds capability-gated payload sanitization, image stripping,
provider format fixups, or model-capability checks inside the LC adapter/dispatch
layer is suspicious by default.** Before approving:
1. Demand the failing transcript/payload that shows the root cause.
2. Check pi-ai's installed source (`node_modules/@earendil-works/pi-ai/dist`) for
   the same behavior.
3. If LC genuinely needs a belt-and-braces invariant, it belongs at the
   `toPiMessage` boundary and must be capability-independent.
4. Tests that use `as never` / `as any` to inject message shapes are proof no
   typed producer emits those shapes, they pin fiction.

This generalizes: for ANY dependency adopted to own a domain (pi-ai for
providers, letta-client for API types, Ink for rendering), a PR that
re-implements that domain inside this fork needs explicit justification.

### Leaked Module Mocks in Tests

`mock.module()` is applied to the global module registry of the Bun worker
process, not scoped to the current test file. A mock set in `foo.test.ts` can
silently affect `bar.test.ts` if they share a worker.

- If a test file must use `mock.module()`, register it in
  `scripts/isolated-unit-tests.json` so it runs in a standalone Bun process.
- Save real implementations before mocking, restore in `afterAll`.
- **Review signal:** any test using `mock.module()` without `afterAll`
  restoration, especially if the mocked module is consumed by other test files.

### Don't Rename Existing Test Fixtures

When adding a feature that uses a different provider/entity name, ADD new
tests, don't rename existing test references. Bulk-renaming entity names in
existing tests creates unnecessary diff noise.

- **Review signal:** any PR that bulk-renames entity names in existing tests
  when the rename isn't the PR's purpose.

### Spec Files and Planning Docs Are Internal

`SPEC-*.md` in the repo root and the numbered `docs/NN-*.md` planning documents are the
maintainer's working notes, not PR content, and not something a clone needs. Both are listed in
`.gitignore` for that reason — and the reason is not tidiness: they record the maintainer's
reasoning, and several of them contain that machine's absolute paths, harness paths and
agent/conversation ids, so committing them publishes all of it and GitHub history is permanent.

- Never `git add` them, never `git add -A` without checking, and never "help" by committing them.
- `docs/examples/**` (the mod examples) and `docs/commands.zh-CN.md` (the command manual) are
  shipped assets, are tracked, and are **not** covered by the ignore rules. Do not move them to
  match the pattern.
- If a change seems to need a planning note committed, it belongs in `CONTRIBUTING.md`
  (the itemised change list) instead.

### No Upstream Patching (Ink)

The fork no longer vendors or string-patches Ink. `vendor/` and
`scripts/postinstall-patches.js` were removed when the TUI moved to Ink 7. The
behaviors those patches provided are now either native Ink 7 features (Kitty
keyboard protocol via the `kittyKeyboard` render option, bracketed paste via
`usePaste`, `<Static>`-identity reset, overflow handling, `log-update`
clear/sync) or owned code.

- Do not string-patch `node_modules/ink`, and do not re-vendor upstream files.
  The one build-time accommodation is the `react-devtools-core` stub in
  `build.js` (Ink loads devtools through a guarded dynamic import).
- Prefer Ink's public seams: `render()` options and the exported hooks. The only
  private API still used is `internal_eventEmitter` on `useStdin()` (raw escape
  sequences in `PasteAwareTextInput`).

---

## Extension & Mod System

### Architecture

```
AppCoordinator
  -> Adapter (extension-adapter)     , app-facing lifecycle, context, reload
    -> Engine (extension-engine)     , loads extensions, maintains registry
      -> Extension code             , user-authored .ts/.tsx files
```

- **Adapter** owns app-facing lifecycle: create/reload/dispose, loading flags,
  current mutable context, React subscription surface.
- **Engine** owns extension mechanics: discover/transpile/import/activate,
  create the `haruyuki` API object, maintain registry, invoke event handlers,
  record diagnostics.
- **Registry** = engine-owned snapshot of extension-contributed things.
  Extensions write indirectly through `letta.*` APIs. App reads snapshot to
  render/use them.

Key files:
- `src/extensions/extension-adapter.ts` , types, `hasExtensionSources`, `createExtensionAdapter`
- `src/extensions/extension-engine.ts` , engine, loads extensions, maintains registry
- `src/extensions/conversation-handle.ts` , scoped conversation handle (`fork`, `getHistory`, `sendMessageStream`)
- `src/extensions/disabled-extension-adapter.ts` , null-object adapter when extensions disabled

### Kill Switch

- `--no-extensions` CLI flag
- `HARUYUKI_DISABLE_EXTENSIONS=1` environment variable

### Mod vs Extension Location

- **Mods** go in `~/.haruyuki/mods/`, simple `.ts` files, auto-loaded on session
  start or `/reload`.
- **Extensions** go in `~/.haruyuki/extensions/`, legacy `.ts`/`.tsx` files
  compiled to `.mjs` via TypeScript transpilation.
- `resolveDefaultGlobalModsDirectory` prioritizes `~/.haruyuki/mods/` over
  `~/.haruyuki/extensions/` when both exist. Extensions get silently shadowed.
- Compiled extensions cached in `~/.haruyuki/extension-cache/`.
- Feature-checked mod files (checking `haruyuki.capabilities.*` before calling
  `haruyuki.ui.*`) are safe to leave in `~/.haruyuki/mods/` across different builds.

### Capabilities

Extensions check `haruyuki.capabilities.*` before using surfaces. When a capability
is `false`, the API is stubbed to no-op (not throw). Key capabilities:
`events.lifecycle`, `events.turns`, `ui.panels`, `ui.dialogs`, `commands`,
`tools`, `providers`.

Listener (`LISTENER_MOD_CAPABILITIES`): `events.turns: false`, `ui.panels:
false`, `ui.dialogs: false`. Panel-based mod commands show in the picker but
silently fail to render.

### Events

Lifecycle: `conversation_open` / `conversation_close` (NOT `session_start` /
`session_shutdown`).

Turn: `turn_start` (pre-send, handlers can mutate input) / `turn_end`
(post-turn, handlers can return `{ continue: "..." }` effect).

- `turn_start` handlers receive the raw mutable `MessageCreate[]` input array.
  Both mutation and functional return styles work. Engine applies returned
  `{ input }` immediately so next handler sees updated input.
- Rollback on handler error: input restored before continuing to next handler.
- `null` conversation ID before first message, guard with
  `if (ctx.conversation.id)`.
- First-handler-wins for effect-returning events: first handler returning an
  effect wins; subsequent handlers are shadowed.
- `llm_end`/`turn_end` don't fire on errors. No mod error event exists. No
  same-turn retry.

### Panel & Statusline (Unified)

`openPanel({ id, order, render }) -> { update, close }` is the sole mod UI
primitive. `openStatusline` is folded into `openPanel`.

**Signed-order coordinate:**
- `0` = primary (reserved `"primary"` id, replaces built-in `agent . model`)
- `1` = product-status replacement (singleton, newest-wins)
- Negative = below input, positive > 1 = above input (additive stacking)
- Higher number = higher on screen. Sort descending, ties -> most-recently-updated.

**Render function:** `render: (ctx) => string | string[]`. Must be cheap and
pure, no I/O, no side effects. Host calls it on frame cadence.

**Key-based lifecycle:** upserts by `id`. `closePanel(id)` removes. Handle
methods: `{ update: () => void; close: () => void }`. `update()` is a dirty flag,
not data passing, state works via closure mutation.

**Render context:** `ModPanelRenderContext` extends `ModContext`, panels get
the full live mod context plus `width`, `row(left, right, width)`,
`columns(items, width)`, `chalk`.

**Legacy `{ content }` API silently no-ops.** Runtime validation emits a warning
diagnostic. When debugging a mod that "does nothing", check whether it uses
`content` instead of `render`.

**Async commands pattern:** fetch data outside render, store in closure, call
`panel.update()` when data arrives, `render: () => state.result ?? loading_text`.

### Mod Dialogs

`haruyuki.ui.select({ message, options }) -> Promise<string | null>` , blocking,
modal, captures keyboard focus. Renders below input, preempts statusline +
below panels. ESC resolves `null`.

- `ui.dialogs` capability gated. When disabled: resolves `null` (not throw).
- Self-dequeuing resolver: promise resolve function removes its own entry from
  the queue. Without this, zombie dialogs persist.
- Input blocking parity: must set `inputEnabled = false` in AppCoordinator
  during active dialog, not just collapse input visually. Otherwise main input
  and dialog both catch Enter.
- Desktop transport: mod dialogs are registry-keyed by `id`, not tool calls, so
  they can't ride the permission channel. Desktop needs new WS commands.

### Mod Secrets

`ctx.secret(KEY, { envFallback: true })` , minimal primitive, agent-scoped, env
fallback opt-in, redacted from output. Secrets are substituted at command
dispatch time, not as persistent env vars. Only literal `$NAME` references work
(not `${NAME}`).

### Mod Package Publishing

- npm publish requires `./` prefix for package path.
- `git:` prefix for GitHub-installed mods.
- Package manifest: capability ID sourced from manifest, fail-closed.
- Version bumping for breaking API migrations: bump package version, set
  `engines.lettaCodeCli` to `>= N+1` where N is the current released Haruyuki
  version (the breaking change isn't released yet).

---

## App-Server Protocol

The v2 app-server protocol (`src/types/protocol_v2.ts`) is the runtime-scoped
protocol for Desktop/app-server. It replaces the v1 session/headless protocol.

### Adding a Protocol Command

1. Add the command interface near related commands in `protocol_v2.ts`.
2. Add it to the `WsProtocolCommand` union type.
3. Add a handler in `src/websocket/listener/message-router.ts`.
4. If it needs a response: add a response interface and add it to
   `WsProtocolMessage` union.
5. Update `src/websocket/listener/protocol-inbound.ts` for outbound parsing.
6. Add an `AppServerClient` helper method + tests in the same PR. Don't ship
   protocol commands without their client ergonomic.
7. Cloud relay forwarding is **not in this repo**: `FORWARDABLE_COMMAND_TYPES`
   lives in the separate letta-cloud codebase. Reaching a hosted relay is a
   change on the relay side, not here.

**Naming:** No "codex" references in codebase/commits/identifiers. Use
"app-server JSON-RPC shape" or "reference app-server shape" if needed.

**AppServerClient ergonomic gap pattern:** When a protocol command family is
added, these surfaces normally need updates: protocol types, inbound validation,
listener handler, and the `AppServerClient` helper in `src/app-server-client.ts`
(**often missing** — do not ship a command family without its client ergonomic).
Relay forwarding and desktop passthrough are maintained outside this repo. Do
not eyeball the gap: diff the command types in `protocol_v2.ts` against the
helpers on `AppServerClient`.

### Protocol v1 vs v2

- v1 = session/headless: one running session, raw streaming chunks,
  `control_request`/`control_response`. Good for: spawn headless -> send prompt
  -> stream result.
- v2 = app-server: many runtimes in one environment, explicit runtime scope
  (agent_id + conversation_id), state snapshots, typed sideband commands, split
  control/stream channels, idempotency/reconnect/sync.

### `runtime_start`

One-shot entry point: create or resume a runtime scope. Resolution:
`create_agent` present -> create; else require `agent_id` and retrieve.
`conversation_id` present -> retrieve; else create for resolved agent.

Response: `created.agent` / `created.conversation` booleans only. Don't leak
internal implementation details like whether a JS `ConversationRuntime` was
newly allocated.

---

## Filesystem Sandbox

OS-level filesystem sandboxing prevents agents sharing one machine from reading
or writing each other's memory.

### Enforcement Surfaces

1. **Shell commands:** wrapped per invocation with cross-agent policy (deny
   active agent-memory tree, carve current agent's own memory back out, leave
   repo/home/tmp writable, network open).
2. **Memory-mode subagents** (reflection, memory, init):
   entire process wrapped. Reads broadly, writes restricted.
3. **In-process file tools** (Read/Edit/Write): cannot fork, so kernel sandbox
   can't see them. Old static cross-agent guard remains: resolves both lexical
   and realpaths to cover symlink escapes.

### Backends

- **Seatbelt (macOS):** `detectSandboxBackend()` must actually probe
  (`sandbox-exec -p '(version 1)(allow default)' /usr/bin/true`), not just check
  file existence. If probe fails, degrade to no-sandbox.
- **bwrap (Linux):** mount namespace, root `--bind / /` for cross-agent mode,
  `--ro-bind / /` for memory mode. Denied roots `--tmpfs` masked.
- **Windows:** C# helper with restricted tokens + temporary ACLs + kill-on-close
  Job Object. Uses `S-1-5-21-*` domain-shaped SIDs (NOT `S-1-15-3-*` capability
  SIDs which fail on standard Windows). `asInvoker` manifest to avoid UAC.

### Cross-Backend Policy

Sandbox policy must deny BOTH memory trees, because two agents on one machine
may be on different backends:
- API/cloud-shaped agents: `~/.haruyuki/agents`
- Local backend: `$LETTA_LOCAL_BACKEND_DIR`/memfs (default
  `~/.haruyuki/lc-local-backend`)

Keep both denials regardless of which backend this fork runs. The split is
covered by `src/permissions/harness-path-whitelists.test.ts`.

### Environment Variables

- `HARUYUKI_FS_SANDBOX=0` , opt-out everywhere
- `LETTA_SANDBOX=<backend>` , sentinel inside sandboxed children

---

## Runtime Model Catalog

The model catalog is a dynamic runtime service, not a static `models.json` file.

**This fork is local-only.** There is no hosted catalog and no BYOK row
merging. The local path projects the active pi-ai or server runtime inventory
into `CatalogModel` shape via `toRuntimeCatalogModels()`; if pi-ai is
unavailable the local catalog is empty and startup continues. Do not add a
fallback that queries a hosted `GET /v1/models` — the cloud-egress guard rejects
importing the modules that would, and `.skills/adding-models/SKILL.md` carries
the same rule.

**If you ever port a cloud-mode change in:** hosted selector rows, labels,
presets and capabilities would have to come only from `GET /v1/models/catalog`,
with `GET /v1/models` contributing organization-specific BYOK rows and nothing
else. Never let its base/hosted rows filter, supplement or stand in for a hosted
catalog, and never rewrite provider names to make them look like catalog rows.
This paragraph is upstream guidance kept only so a port does not repeat an old
bug — it describes no code in this repo.

Key files: `src/agent/model-catalog.ts`, `src/agent/remote-model-catalog.ts`,
`src/agent/available-models.ts`, `src/backend/local/local-model-config.ts`.

**Test fixture pattern:** The `models` array is shared mutable state across the
test suite. Use `setupRuntimeModelCatalogFixture()` (bundles setup + cleanup) from
`src/test-utils/runtime-model-catalog.ts`. All test files touching the model
catalog must use this fixture.

---

## Subagent Lifecycle & Reflection

### Subagent Lifecycle API

- `ctx.subagents.list()` , returns fuller lifecycle items (type, status,
  durationMs, agentId, visibleInTranscript). No `active` field (use `pending ||
  running`). No `surface` field (use JS `.filter()`). No filter sugar.
- `ctx.backgroundAgents` , slim projection (`type`, `status`, `durationMs`,
  `agentId`). Sufficient for minimal text-only rendering.
- Both read from the same source (`subagentLifecycleSnapshot` in `InputRich`).
  Difference is projection depth.
- Completed/error agents retained ~30s before cleanup. Consumers must filter on
  `status` if they only want active agents.

### Product-Status Panel

- `order: 1` = product-status replacement (singleton, newest-wins).
- Built-in default panel injected by `InputRich` when no user panel occupies
  `order: 1`.
- User mod at `order: 1` suppresses the built-in default.
- `ctx.link(label, url)` helper for OSC-8 hyperlinks. In tmux, OSC-8 doesn't
  work, default panel omits URL entirely.
- Spinner state is host-owned, fed to default panel via options. A user mod at
  `order: 1` runs its own `setInterval` + `panel.update()` to animate.

### Reflection Worktree

Harness manages the worktree lifecycle (not the reflection agent):
- State: `landed` (clean merge), `noop` (no commits), `retry` (dirty),
  `pending_integration(reason)` (merge failed, branch preserved).
- Reflection agent NEVER semantically resolves conflicts.
- Transcript marked consumed only when memory lands on main.
- Reflection settings are per-agent; trigger counter is per-conversation.
- Counter increments on completed assistant steps (not user messages, not tool
  calls, not interrupted turns).

---

## Cross-Platform Patterns

### Windows Symlinks

`fs.symlink(source, dest, "dir")` on Windows requires elevated privileges
(Developer Mode or admin). Use `"junction"` type on win32 instead, doesn't
require elevated privileges.

```ts
fs.symlink(target, dest, process.platform === "win32" ? "junction" : "dir")
```

### Windows-Specific

- `PATH` vs `Path` case sensitivity (Node uses `Path`).
- `node -e 'script'` quoting breaks, use a temp file.
- `/bin/sh` doesn't exist, don't use in fallback paths.
- Worktree path length: use shorter dirname (`"wt"` vs `"worktree"`) on Windows.
- `process.kill(pid, 0)` for stale lock detection works but behavior differs
  slightly.

### Turbopack Symlinked node_modules

In worktree setups where `node_modules` is symlinked, Turbopack rejects
symlinks pointing outside the project root. Replace with hard links:
`rm node_modules && cp -al <source_dir> ./node_modules`.

### next-env.d.ts Regeneration

`next-env.d.ts` gets regenerated during `next dev` with `.next/dev/types/`
paths. Revert before committing: `git restore next-env.d.ts`.

---

## Git Workflow Patterns

### Squash-Merge Stacked PR Conflicts

PRs use squash merge. When PR A is squash-merged, downstream PR B (stacked on A's
branch) gets auto-retargeted to main by GitHub, creating conflicts because the
commits B expected no longer exist.

**Fix:** `git rebase --onto origin/main <pr-a-base-commit> <pr-b-branch>` ,
replay only PR B's commits onto main, dropping PR A's now-redundant commit.

### Squash-Merge Rebase Trap

After a PR is squash-merged, a branch based on the old unsquashed commits will
have duplicate changes if you do a normal `git rebase origin/main`.

**Fix:** stash the diff (`git stash push -u`), reset to main
(`git reset --hard origin/main`), apply the stash (`git stash apply`), resolve
only the real PR conflicts.

### Stash-Rebase-Apply for Uncommitted Spikes

When a worktree branch has uncommitted spike changes and needs rebasing onto
fresh main:
1. `git stash push -u -m "spike: ..."`
2. `git fetch origin main && git rebase origin/main`
3. `git stash pop` (conflicts expected)
4. Resolve conflicts, `git restore --staged .` to unstage
5. `git stash drop` after clean apply

### bun.lock Churn

Running `bun install` in a worktree may add `"configVersion": 0` after
`"lockfileVersion": 1` because the local Bun version is newer. Scrub with
`git checkout main -- bun.lock` when the PR has no real package.json change.

### Git Rebase in Non-Interactive Contexts

`git rebase --continue` opens vim. Use `GIT_EDITOR=true git rebase --continue`
to accept the default message without opening an editor.

### GitHub Token Types

- `gho_` (OAuth): works for `gh` CLI API calls, NOT for `git push` over HTTPS.
- `github_pat_` (fine-grained PAT): works for `git push` but only for
  user-owned repos, NOT org repos unless org approves.
- `ghp_` (classic PAT): works for everything including `git push` to org repos.
  This is the right type for pushing to the fork repository, which is
  `TZYLT/haruyuki` (remote name `haruyuki`). The old `TZYLT/letta-chat-better`
  name still resolves through GitHub's rename redirect, but do not push to it.
  The upstream `letta-ai/letta-code` remote is read-only reference material here.
- Push URL: `git push https://<user>:<token>@github.com/<org>/<repo>.git <branch> --force`

### Letta API notes apply only if you call the hosted API

This fork is local-only and has no code path that queries
`GET /v1/conversations`. If you port something from upstream that does, two
upstream traps are worth keeping: the conversation-list query param is
`summary_search`, not `summary` (the API silently ignores unknown params, so
`summary` returns **all** conversations for the agent), and `@letta-ai/*` wire
types must be extended rather than redeclared.

---

## Secret Injection Syntax

The harness only supports literal `$NAME` references for secret injection:
- `$MY_SECRET` injected
- `${MY_SECRET}` not expanded
- `${MY_SECRET:?}` not supported

---

## Cloud & Teleport

This fork removed cloud and teleport wholesale — see `CONTRIBUTING.md` §A for
the itemised list (teleport, remote-computer and environment routing, hosted
sandboxes, hosted schedules, shared memory, and the cross-repository release
orchestration).

None of the upstream notes that used to live here are actionable in this tree,
and the code they described is gone; grep confirms zero hits for each:

- the teleport protocol and its `TELEPORT_SOURCE_NOT_ACTIVE` handling;
- `pickDesktopLocalConnection` and desktop device routing;
- the dual local/cloud listener and its heartbeat behaviour.

Do not reintroduce any of them without recording the decision in
`CONTRIBUTING.md`. The `cloud-egress` check exists specifically to keep the
egress modules out of production imports.
