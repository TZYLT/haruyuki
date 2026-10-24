---
title: Memory filesystem (MemFS)
description: Where agent memory lives, the two on-disk layouts, the git repository behind it, and the rules the pre-commit hook enforces.
applies_to:
  backends: [local]
  interfaces: [cli, desktop, sdk]
---

# Memory filesystem (MemFS)

An agent's memory is a git repository on this machine. That single fact explains
most of the behavior below: writes are commits, history is real, and a
pre-commit hook can refuse a change.

## Where memory lives

- The scoped memory root is `<storageDir>/memfs/<agentId>/memory`, computed by
  `getScopedMemoryFilesystemRoot` — `src/agent/memory-filesystem.ts:83-89` and
  `src/backend/local/paths.ts:48-53`.
- `<storageDir>` defaults to the harness home's `lc-local-backend`
  subdirectory, and its override key is `LETTA_LOCAL_BACKEND_DIR` —
  `src/utils/local-backend-paths.ts:9`, `src/utils/local-backend-paths.ts:20-28`.
- The cross-agent boundary is `<storageDir>/memfs` — that whole tree is the
  unit sandbox policy denies to other agents —
  `src/utils/local-backend-paths.ts:36-39`.
- `HARUYUKI_HOME` moves the entire user-level root, memory included —
  `src/utils/app-paths.ts:78-82`, `src/utils/app-paths.ts:88-93`.
  `getMemoryFilesystemRoot` deliberately goes through `appHomeRoot` instead of
  joining a home directory itself, because the sandbox policy would otherwise
  deny the write — `src/agent/memory-filesystem.ts:51-54`.
- Two variables *replace* the computed path rather than feeding it:
  `LETTA_MEMORY_DIR` then `MEMORY_DIR`, used when no explicit or runtime agent
  id is available — `src/agent/memory-filesystem.ts:128-131`.
- `LETTA_TRANSCRIPT_ROOT` is unrelated to memory: it only sets where reflection
  and memory subagent transcripts go — `src/utils/transcript-paths.ts:17-23`.

## A fresh agent's tree

Creating a local agent produces exactly this, asserted by a test that reads the
directory — `src/backend/local-fresh-memory-layout.test.ts:44-60`:

```
.git/
MEMORY.md          # "# Memory\n" — the root index, no frontmatter
persona.md         # name: + description: frontmatter
human.md           # name: + description: frontmatter
```

- `MEMORY.md` comes from the root memory block —
  `src/backend/local/initial-memory.ts:55-57`; the block is stamped onto the
  create request by `stampRootMemoryOnCreateBody` —
  `src/agent/memory-filesystem.ts` (see the import at
  `src/backend/local-fresh-memory-layout.test.ts:6`).
- Non-root labels are flattened into the root: a slash becomes an underscore —
  `src/backend/local/initial-memory.ts:25-28`. Two labels that flatten onto the
  same path are rejected with `Initial memory path collision at <path>` —
  `src/backend/local/initial-memory.ts:110-117`.
- In root layout every non-root memory file must carry `name` **and**
  `description`; the legacy layout writes `description` only —
  `src/backend/local/initial-memory.ts:63-74`.

## Two layouts, and how each is detected

- `detectMemoryFormat` looks for `MEMORY.md` at the root: present means
  `memfs-v2`, absent means `memfs-v1` —
  `src/agent/memory-format.ts:6-11`. The compiler has an equivalent check over
  the git tree — `src/backend/local/system-prompt-compilation.ts:131-133`.
- Which one an agent uses is decided by the layout policy the hooks were
  installed with: `"legacy-only"`, `"root-marker"`, or `"shared-memory"` —
  `src/agent/memory-git-hooks.ts:21-22`. The policy is persisted under the git
  directory as `letta-memory-layout-policy` —
  `src/agent/memory-git-hooks.ts:204-209`.
- Core memory differs by layout: v2 core files are root-level Markdown (no
  slash in the path); v1 core files live under `system/` —
  `src/agent/memory-format.ts:13-21`.
- Projection differs too: v1 projects everything, v2 projects a file only when
  every ancestor directory has its own `MEMORY.md`, and never projects
  `skills/` — `src/agent/memory-format.ts:23-41`.

## What the pre-commit hook refuses

The hook is a shell script installed at `.git/hooks/pre-commit`, with its
validator next to it as `.git/hooks/letta-memory-constraints.cjs` —
`src/agent/memory-git-hooks.ts:195-208`.

- **A directory without its own `MEMORY.md` index.** Under v2 validation the
  required index is checked per level, and the error reads
  `<dir>/MEMORY.md: missing required index` —
  `src/agent/memory-constraints.ts:58-71`. This is the rule that made the old
  `system/persona.md` write path fail on a v2 agent —
  `src/agent/personality.ts:113-139`.
- **Flat skill files.** Skills must be folders:
  `skills/<name>/SKILL.md`. A flat file directly under `skills/` is rejected with
  `invalid skill path (skills must be folders)` — v2 branch
  `src/agent/memory-git-hooks.ts:148-151`, legacy branch
  `src/agent/memory-git-hooks.ts:164-168`.
- **`MEMORY.md` with frontmatter.** The root index must not start with `---` —
  `src/memory-frontmatter.ts:27-31`. Every other memory file must have a closed
  frontmatter block — `src/memory-frontmatter.ts:32-40`.
- **Unknown or malformed frontmatter.** In v2 the allowed keys are exactly
  `name` and `description`, both non-empty and not repeated; in v1 only
  `description` is required, with `read_only` and `limit` also allowed —
  `src/memory-frontmatter.ts:64-66`, `src/memory-frontmatter.ts:102-111`.
- **Touching a `read_only` file.** `read_only: true` is protected: an agent may
  not add, change, or remove it, and a file already marked read-only at `HEAD`
  cannot be modified at all — `src/memory-frontmatter.ts:55-61`,
  `src/memory-frontmatter.ts:91-120`.
- **Changing `.memfs.config.json` without approval.** It is protected and
  requires `HARUYUKI_MEMORY_CONSTRAINTS_UPDATE=1` —
  `src/agent/memory-constraints.ts:30-31`,
  `src/agent/memory-constraints.ts:132-139`.
- Legacy layout validates only `(memory/)?(system|reference)/**.md` —
  `src/agent/memory-git-hooks.ts:170-175`.

When the hook refuses, the message is
`Memory validation blocked this commit.` and the commit exits 1 with the
staging area left intact — `src/agent/memory-constraints.ts:92-122`. The
guidance in that message is to split the file rather than raise the limit.

## Size and depth limits

Defaults live in one frozen object —
`src/memory-constraints.ts:260-266`:

| Limit | Default |
| --- | --- |
| `maxDepth` | 2 |
| `maxFileCharacters` | 20,000 |
| `maxCoreMemoryCharacters` | 65,536 |
| `version` | 1 |

- The configuration file is `.memfs.config.json` at the memory root —
  `src/memory-constraints.ts:157-158`. Malformed values (unknown fields, a
  version other than 1, non-positive integers, invalid globs, a `**` that is
  not a whole segment) are rejected at parse time —
  `src/memory-constraints.ts:163-257`.
- `fileCharacterLimits` can override the per-file limit by glob; the first
  matching entry wins, and `maxCharacters: null` means unlimited —
  `src/memory-constraints.ts:72-98`.
- Over-limit errors name the file and the source of the number, e.g.
  `depth N exceeds maxDepth M` or
  `N characters exceeds L from maxFileCharacters` —
  `src/memory-constraints.ts:100-153`.
- An audit path validates the committed tree without touching the index, using
  a temporary `GIT_INDEX_FILE` plus `git read-tree HEAD` —
  `src/agent/memory-constraints-audit.ts:52-89`.
- Separately, the prompt budget estimates tokens with
  `SYSTEM_PROMPT_BYTES_PER_TOKEN = 4`; v2 counts root-level `.md` files while
  v1 walks `system/` — `src/agent/system-prompt-size.ts:17`,
  `src/agent/system-prompt-size.ts:82-94`. `haruyuki memory tokens` prints the
  largest files — `src/cli/subcommands/memory-tokens.ts:7`.

## Git: who commits, and when it pushes

- Memory commits go through `commitMemoryWrite`, which stages with
  `git add -A -- <pathspecs>`; with nothing staged it reports
  `{ committed: false }`, and a failed commit rolls the index back with
  `git reset HEAD -- <pathspecs>` — `src/agent/memory-git.ts:1234-1273`.
- Author identity: the commit uses the agent's `authorName` (falling back to
  its id) and `authorEmail`, falling back to the operator's global identity —
  `src/agent/memory-git.ts:1198-1206`.
- The operator identity comes from `git config --global`; when unset the
  fallbacks are `Haruyuki Code` and `noreply@haruyuki.local` —
  `src/agent/memory-git-identity.ts:21-24`,
  `src/agent/memory-git-identity.ts:37-47`.
- Two git config keys keep their old names because they are already written on
  disk: `letta.agentId` — `src/agent/memory-git.ts:844-847` — and
  `letta.memoryRepository.url` — `src/agent/memory-git.ts:886-892`.
- The post-commit hook reads `letta.memoryRepository.url` with
  `git config --local --get`; when it is unset the hook exits 0, and it pushes
  only from `main`, in the background, logging to
  `<git-dir>/memory-repository-push.log` —
  `src/agent/memory-git-hooks.ts:254-274`.
- End-of-turn sync pushes only when the repository is initialized, has an
  origin, is clean, is not conflicted, and is ahead; a non-fast-forward retries
  with `pull --rebase` — `src/agent/memory-post-turn-sync.ts:61-141`. A
  local-only repository has no remote, so the sync reports that there is
  nothing to push — `src/agent/memory-post-turn-sync.ts:73-80`.
- `pullMemory` tries `git pull --ff-only` first. If the histories share no
  merge base it backs the old `HEAD` up under
  `refs/letta-backup/pre-sync-<timestamp>` and resets to the remote; otherwise
  it falls back to `pull --rebase` — `src/agent/memory-git.ts:1588-1684`.

## Worktrees

- Memory worktrees live beside the repository, in `memory-worktrees/`, with
  branch names `haruyuki/<label>/<id>` —
  `src/agent/memory-worktree.ts:136-167`. Reflection uses the label
  `reflection` — `src/agent/memory-worktree.ts:142` — and the memory worker uses
  `memory-worker` — `src/agent/subagents/memory-worker.ts:156-159`.
- Integration removes the worktree and merges the branch with
  `git merge --no-edit -m "merge(memory): <branch>"`; a conflict aborts the
  merge and keeps the branch — `src/agent/memory-worktree.ts:690-748`.
- A reflection is finalized as one of `merged`, `no_changes`, `parent_dirty`,
  `merge_conflict`, `dirty_uncommitted`, or `failed` —
  `src/agent/memory-worktree.ts:226-232`. Only `merged` and `no_changes`
  consume the transcript — `src/agent/memory-worktree.ts:246-250`.
- `enter-worktree` and `exit-worktree` do **not** touch the memory worktree:
  they act on the repository working directory and `.haruyuki/worktrees/` —
  `src/tools/impl/enter-worktree.ts:172`,
  `src/tools/impl/exit-worktree.ts:185-196`. `$MEMORY_DIR` points at a
  worktree only inside a subagent run —
  `src/agent/subagents/subagent-launcher.ts:261-275`.

## Files inside the tree

| Path | Meaning | Source |
| --- | --- | --- |
| `MEMORY.md` | v2 root marker and index; must have no frontmatter | `src/agent/memory-format.ts:6-11`, `src/memory-frontmatter.ts:27-31` |
| `<dir>/MEMORY.md` | Index required for every directory that holds projected memory | `src/agent/memory-format.ts:33-40` |
| `persona.md` / `human.md` | v2 root self and human blocks | `src/backend/local/system-prompt-compilation.ts` (v2 section), `src/agent/personality.ts:43-48` |
| `system/persona.md` / `system/human.md` | v1 self and human blocks (legacy layout) | `src/agent/personality.ts:43-48`, `src/backend/local/system-prompt-compilation.ts:351-360` |
| `ARCHIVE.md` | Where retired but still useful context is appended, dated; sensitive or wrong content is deleted instead | `src/agent/subagents/builtin/reflection.md:102`, `src/agent/subagents/builtin/reflection-v2.md:103` |
| `skills/<name>/SKILL.md` | Agent-installed skills; flat `.md` files are rejected | `src/tools/impl/skill.ts:72-88`, `src/agent/memory-git-hooks.ts:148-151` |
| `reference/` | Supporting material; in v2 it needs its own index | `src/backend/local/system-prompt-compilation.ts:218-222` |
| `profile.png` | Visual identity used by the local prompt | `src/agent/prompts/haruyuki_local_memfs.md:88` |

`ARCHIVE.md` has no TypeScript references: its meaning is defined by the
reflection prompts alone, so treat spacing and naming there as prompt-level
conventions rather than code constants.

## Writing to memory

- A file-write tool touching only the agent's own memory roots is
  auto-approved by `isOwnMemoryWrite`, which checks both the written path and
  its real path so a planted symlink cannot redirect the write; the tool set is
  `Write`, `Edit`, `ApplyPatch` —
  `src/permissions/memory-write-allowance.ts:17`,
  `src/permissions/memory-write-allowance.ts:37-61`.
- The cross-agent guard runs first and applies to non-shell tools; shell
  commands are left to the kernel sandbox —
  `src/permissions/cross-agent-guard.ts:389-441`.
- The writable roots are resolved from `MEMORY_DIR` / `LETTA_MEMORY_DIR` when
  set, including the sibling `memory-worktrees` directory, and otherwise from
  the current or parent agent's scoped root —
  `src/permissions/memory-paths.ts:70-84`,
  `src/permissions/memory-paths.ts:131-209`.
- Sandbox policy denies both memory trees, because two agents on one machine may
  run different backends: the harness `agents` tree and `<storage>/memfs` —
  `src/permissions/sandbox-policy.ts:41-59`.

**Platform fact, verified in code:** the kernel sandbox has exactly two
backends, `seatbelt` (macOS) and `bwrap` (Linux) —
  `src/sandbox/policy.ts:48`. On any other platform, including Windows,
  `probe()` returns no backend with the reason
  `no filesystem sandbox backend for platform "<p>"` —
  `src/sandbox/availability.ts:117-136`. So on Windows the confinement is a
  no-op and the in-process guards above are the only enforcement. Memory
  subagent confinement is on by default (`HARUYUKI_FS_SANDBOX` unset), while
  shell sandboxing requires opting in — `src/sandbox/availability.ts:65-94`.
