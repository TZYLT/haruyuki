---
title: Context, frozen prefixes, and compaction
description: How this build keeps a provider prefix stable, how it reports pending changes, and how /compact and the compression rate decide what is trimmed.
applies_to:
  backends: [local]
  interfaces: [cli]
---

# Context, frozen prefixes, and compaction

Three mechanisms share this subject and are easy to confuse:

1. a **prefix freeze**, which is why a change does not take effect immediately;
2. **topic markers**, which are metadata that draw boundaries in the transcript;
3. **compaction**, which is the only operation that rewrites history — and it
   only runs when you ask for it.

## The frozen prefix

What is frozen:

- The compiled system prompt, the skills block, the tool declarations
  (`client_tools`), and the model plus model settings —
  `src/backend/local/prefix-freeze.ts:15-21`,
  `src/backend/local/prefix-freeze.ts:134-170`.
- The freeze is persisted, not recomputed per turn. The private
  `compileAndMaybePersistSystemPrompt` writes it —
  `src/backend/local/local-backend.ts:989-1026`.

Where the freeze is allowed to be rewritten (the "application points"):

| Point | Reason recorded | Source |
| --- | --- | --- |
| `createAgent` | `conversation_created` | `src/backend/local/local-backend.ts:325-328` |
| `createConversation` | `conversation_created` | `src/backend/local/local-backend.ts:395-403` |
| `/recompile` | `manual_recompile` | `src/backend/local/local-backend.ts:423-441` |
| after a topic trim | `compaction` | `src/backend/local/local-backend.ts:672-676` |
| after a compaction | `compaction` | `src/backend/local/local-backend.ts:907-911` |
| ordinary turn compile | `conversation_created` | `src/backend/local/local-backend.ts:982-986` |

- A fork inherits its parent's freeze, recorded as `fork_inherited`, and only
  within the same agent — `src/backend/local/local-store.ts:905-918`.
- The four reasons are a closed union —
  `src/backend/local/system-prompt-compilation.ts:28-32` — and a repo check
  enforces who may rewrite a frozen prefix and which reasons an application
  point may record — `scripts/check-recompile-callsites.js:29-69`.
- The collections are frozen once. The first non-empty tool or skill set wins;
  later values are only *observed*, and an observation that returns to the
  frozen value is cleared rather than kept forever —
  `src/backend/local/prefix-freeze.ts:83-132`. The frozen tool set overrides
  live tools in the request body — `src/backend/local/prefix-freeze.ts:148-185`.
- The model is frozen too, so switching models mid-conversation does not affect
  the running conversation until the prefix is rewritten —
  `src/backend/local/prefix-freeze.ts:187-215`.

The hash that detects a system-prompt change is `systemTemplateHash`. It hashes
the `agent.system` template only — not the compiled output, and not the memory
injected into it, which is tracked separately by `memfsRevision` —
`src/backend/local/system-prompt-compilation.ts:38-44`,
`src/backend/local/system-prompt-compilation.ts:507`. Some consumer parameter
names still say `rawSystemHash`; that is a leftover name, not a second field —
`src/backend/local/prefix-freeze.ts:263-264`,
`src/backend/local/prefix-freeze.ts:403-404`.

## `/context pending` reports drift; `/recompile` resolves it

`/context pending` is read-only: it lists changes that are **registered but not
yet applied** — `src/cli/helpers/context-pending.ts:4-8`,
`src/backend/local/local-backend.ts:465-474`. Its report carries
`hasSnapshot`, `memory`, `systemChanged`, `skillsChanged`, `tools`, `model`,
`modelSettingsChanged`, `dirty`, and `hasPending` —
`src/backend/local/prefix-freeze.ts:243-253`.

- The lines it can print include `agent.system: changed`,
  `skills: changed`, added and removed tools, and `applied -> live` for the
  model — `src/backend/local/prefix-freeze.ts:127-144`.
- When nothing is pending it says `No pending prefix changes.` —
  `src/backend/local/prefix-freeze.ts:157-160`.
- Its advice is `Run /recompile to apply now (evicts cache), or wait for
  compaction / a new conversation.` —
  `src/cli/helpers/context-pending.ts:166`.
- Uncommitted working-tree edits in the memory repository are **not** pending:
  `dirty` is reported separately and is excluded from `hasPending` —
  `src/backend/local/prefix-freeze.ts:374-380`,
  `src/backend/local/prefix-freeze.ts:417-428`. When the memory repository
  cannot be read, the report says `reachable: false`, meaning unknown rather
  than empty — `src/backend/local/prefix-freeze.ts:219-233`.

`/recompile` first reads the pending report — so its output doubles as "what
this recompile just applied" — and then rewrites the prefix, always ending with
the cache-eviction warning — `src/cli/helpers/recompile-command.ts:13-40`. The
call chain is `recompileAgentSystemPrompt` →
`LocalBackend.recompileConversation` with `reason: "manual_recompile"` —
`src/agent/modify.ts:695-732`, `src/backend/local/local-backend.ts:423-441`.
That capability is advertised as `promptRecompile`, true for the local backend —
`src/backend/local/local-backend.ts:148`.

## Topic markers

A marker is metadata. It does not modify the transcript and does not modify the
frozen prefix — `src/backend/local/local-backend.ts:498-506`,
`src/cli/commands/topic.ts:98-100`. What it does is draw a boundary that
compaction can cut at.

- `/topic <title> [summary]` writes one with `createdBy: "user"` —
  `src/cli/commands/topic.ts:104-151`. The `TopicMark` tool writes one with
  `createdBy: "agent"` — `src/tools/impl/topic-mark.ts:125-220`. Those are the
  only two values — `src/backend/local/topic-compaction.ts:34-40`.
- Agent markers pass a frequency gate that returns `rejected`, `warned`, or
  `accepted`; a marker identical to the previous anchor is rejected outright —
  `src/backend/local/topic-compaction.ts:509-527`,
  `src/tools/impl/topic-mark.ts:172-186`. User markers are not gated —
  `src/cli/commands/topic.ts:90-97`.
- Limits: a title is at most 60 characters and a summary at most 600 —
  `src/tools/impl/topic-mark.ts:24-25`.
- Boundaries are **derived, not stored**. Each read rewinds from the marker's
  anchor by a number of user turns, default 2, capped at 3 —
  `src/backend/local/topic-compaction.ts:8-11`,
  `src/backend/local/topic-compaction.ts:27-28`; the setting is
  `topicBoundaryRewindTurns` — `src/topic-settings.ts:125-127`.
- `listTopicBlocks` splits the in-context messages into blocks. The last block
  is the still-open current topic, with `title: null` and `createdBy: null` —
  `src/backend/local/topic-compaction.ts:251-334`. A block's `createdBy` comes
  from the marker that *ends* it — `src/backend/local/topic-compaction.ts:295`.
- Whether the picker opens depends on one thing only, `blocks.length > 1` —
  `src/backend/local/local-topic-trim.ts:199-201`. Markers alone are not the
  test: a marker whose boundary clamps to the start of the context produces no
  block of its own — `src/backend/local/local-topic-trim.ts:190-198`.
- The topic-marking section of the prompt is itself part of the frozen prefix,
  so a settings change to it lands at the next application point —
  `src/backend/local/system-prompt-compilation.ts:500-504`.

`/topic list` prints the block table, marking trimmable blocks with `*` —
`src/cli/commands/topics.ts:23-51`. `/topic list --all` instead lists every
marker, and says plainly that those numbers are marker positions, not the block
numbers `/compact` takes — `src/cli/helpers/topic-list.ts:178-211`.

## Compaction: the rate is a compression rate

`sliding_window_percentage` is the share **compressed away**, not the share
kept. `0.3` means "compress about 30%, keep about 70%" —
`src/backend/local/local-topic-trim.ts:49-54`,
`src/cli/app/compaction-settings.ts:60-61`. The default is `0.3` —
`src/backend/local/compaction.ts:44`.

Normalization happens in exactly one place, so no two callers can disagree
about what a setting means — `src/backend/local/compaction.ts:550-559`:

| Input | Effective rate |
| --- | --- |
| `undefined`, `NaN`, non-finite | `0.3` |
| `≤ 0` | `0.1` (the smallest eviction step) |
| `> 1` | `1` |
| anything in between | used as-is |

The retained-token target is

```
retentionCapTokensFor(contextTokens, rate) = floor(contextTokens × (1 − rate))
```

— `src/backend/local/local-topic-trim.ts:175-188`. Two details matter:

- The base is the **in-context transcript**, not the model window. The window
  only decides when a turn is refused — `src/backend/local/local-topic-trim.ts:159-167`.
- An unmeasurable transcript yields `Infinity`, so nothing is compressed blindly
  — `src/backend/local/local-topic-trim.ts:179-185`.

The same formula drives the listener path as `goalTokens` —
`src/backend/local/compaction.ts:611`.

### What each `/compact` form does

| Invocation | Behavior | Source |
| --- | --- | --- |
| bare `/compact` | Resolves to `{ kind: "auto" }`. With two or more blocks it opens the topic picker and trims nothing yet; with a single block it trims by the compression rate and explains why | `src/cli/helpers/compact-command.ts:221-225`, `src/cli/app/submit-compact-commands.ts:477-531` |
| `/compact <n>` | Requires a positive integer; out of range is refused by name with the block count. Sends `{ kind: "topic", index: n }` | `src/cli/helpers/compact-command.ts:236-239`, `src/cli/app/submit-compact-commands.ts:456-471` |
| `/compact help` | Prints usage | `src/cli/helpers/compact-command.ts:226-232` |
| `/compact config` | Opens the mode panel, where the **Compression rate** row is editable | `src/cli/app/use-submit-handler.ts:718-729`, `src/cli/components/CompactionSelector.tsx:145-164` |

Two further facts worth knowing:

- **The rate wins over a pick that would keep too much.** In `resolveTrimPlan`,
  the cap is applied *before* the no-op check, and a pick exceeding it is
  reported with `source: "ratio_cap"`. This is why picking the first block —
  "keep everything" — is meaningful rather than dead: it is compressed to the
  rate's own cut point — `src/backend/local/topic-compaction.ts:431-439`,
  `src/backend/local/topic-compaction.ts:441-502`.
- **The picker's first row is selectable.** All rows, including the first, go
  through the same cap — `src/cli/components/TopicSelector.tsx:7-9`. The footer
  says that anything keeping more than the rate allows will be cut to the rate —
  `src/cli/components/TopicSelector.tsx:128`.

`/compact config`'s editable rate accepts an integer percentage from 1 to 100
and stores it divided by 100 in the agent's
`compaction_settings.sliding_window_percentage` —
`src/cli/components/CompactionSelector.tsx:100-122`,
`src/cli/app/compaction-settings.ts:35-46`. Only changed fields are reported,
and the local backend merges the patch rather than replacing the record, so
setting the rate cannot silently drop the compaction model or the summary
prompt — `src/backend/local/local-backend.ts:374-386`,
`src/backend/local/local-compaction-settings.ts:78-97`. The receipt states the
polarity back: `Compression rate set to N%: each /compact compresses about N% of
the conversation (keeps about 100−N%).` —
`src/cli/app/compaction-settings.ts:48-62`.

## Only your own message triggers a rewrite

There is no background rewrite in the local path. The evidence is explicit
rather than merely absent:

- `This product no longer splits context automatically.` —
  `src/backend/dev/context-window-overflow.ts`. An overflow is terminal:
  `the local backend no longer rewrites history to make room` —
  `src/backend/dev/pi-stream-adapter.ts`.
- A turn applies the prefix and never rewrites it —
  `src/backend/local/local-backend.ts`.
- The pre-send interception has two ratios, and only the hard one compacts.
  Above the soft ratio it warns. At the hard ratio the message cannot be sent as
  it stands, so it compacts by the compression rate through the same
  `prepare → apply` as `/compact`, shows a receipt, and then sends — never in the
  background, never without a receipt, and the message is never dropped —
  `src/cli/app/submit-compact-commands.ts`.
- The commands that rewrite history are user commands: TUI `/compact`, the
  listener's `/compact`, and the `conversation_compact` protocol command —
  `src/cli/app/submit-compact-commands.ts`,
  `src/websocket/listener/commands.ts`,
  `src/websocket/listener/commands/agents-conversations.ts`.

One automatic request-level change exists and is not a history rewrite: when a
retryable transport failure coincides with an oversized payload, old images are
replaced with placeholder text for that one retry —
`src/backend/dev/pi-stream-adapter.ts:741-794`, implementation in
`src/backend/dev/pi-image-elision.ts:138-183`. The source calls it out as
rewriting the request for one retry, never the stored context.

## Pressure warnings and hard refusals

These use a different quantity from compaction, which is deliberate.

- **Soft**: warns above `contextWindow × 0.7` —
  `src/backend/dev/provider-turn-executor.ts:260-261`,
  `src/backend/dev/provider-turn-executor.ts:291-299`. The ratio is the setting
  `topicSoftPressureRatio`; a value of `≤ 0` normalizes to `1`, which switches
  the warning off — `src/topic-settings.ts:87-100`. The warning fires once per
  crossing — `src/cli/app/submit-compact-commands.ts:140-146`.
- **Hard**: refuses the turn above `contextWindow − reserve`, where
  `reserve = min(16384, max(1, floor(contextWindow × 0.2)))` —
  `src/backend/dev/provider-turn-executor.ts:239-258`, constants at
  `src/backend/dev/provider-turn-executor.ts:34-35`. Hard takes precedence over
  soft — `src/backend/dev/provider-turn-executor.ts:272-274`. Refusal raises
  `LocalContextOverflowError` with the actual token count and the window —
  `src/backend/dev/pi-stream-adapter.ts:379-400`.
- **Hard floor**: if the system prompt plus tool definitions alone exceed the
  window, the turn is refused because compaction cannot help —
  `src/backend/dev/pi-stream-adapter.ts:330-363`.

Both thresholds measure the **whole request**, which is why the two numbers can
look inconsistent: the percentage compares the complete context against the
window, while a trim compares only the transcript against the rate. The source
states the mismatch is intentional —
`src/cli/helpers/compact-command.ts:159-175`.

The percentage itself is `round(usedTokens / contextWindowSize × 100)` clamped
to 0–100 — `src/cli/helpers/cli-mod-context.ts:35-48` — with `/context` using
the same arithmetic — `src/cli/helpers/context-chart.ts:46-49`. `usedTokens`
comes from the provider's reported `context_tokens`, which is a snapshot, not an
accumulator — `src/cli/helpers/context-tracker.ts:5-7`,
`src/cli/helpers/accumulator.ts:1339-1355`.

## Telling the two estimates apart

Two similarly named functions estimate very different things, and mixing them up
is the classic way to write a wrong explanation:

| Function | What it measures | Source |
| --- | --- | --- |
| `estimateLocalMessagesTokens` | transcript only; messages summed | `src/backend/local/local-context-estimate.ts:155-162` |
| `estimateLocalMessageTokens` | one message, `ceil(chars / 4)`, images counted as 1200 tokens | `src/backend/local/local-context-estimate.ts:79-118` |
| `estimateProviderContextTokens` | the whole request: anchored usage, else system prompt + messages + tools | `src/backend/dev/provider-turn-executor.ts:189-204` |
| `estimateProviderPromptFloorTokens` | system prompt + tools, the part compaction can never touch | `src/backend/dev/provider-turn-executor.ts:206-220` |

Trimming and the retention cap use the transcript-only number —
`src/backend/local/local-topic-trim.ts:354-358`. Pressure levels and hard
refusals use the whole-request number —
`src/cli/app/submit-compact-commands.ts:115-120`.

Note the name collision: `estimateLocalMessageTokens` in
`src/backend/local/compaction.ts:664-666` takes an array, while the function of
the same name in `src/backend/local/local-context-estimate.ts:79` takes a single
message.
