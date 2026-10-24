---
title: Provenance and similarity audit
description: How these reference documents were produced, what they were allowed to read, and the audit that checked them for borrowed expression.
applies_to:
  backends: [local]
  interfaces: [cli, desktop, sdk]
---

# Provenance and similarity audit

These documents ship inside the package, so a reader is entitled to ask where
their claims came from. This is the answer, and it is deliberately specific
enough to be checked rather than believed.

## Method

Every document under this directory was written from four inputs, in this order
of preference:

1. **This repository's source.** Implementation and JSDoc in `src/`, plus the
   checks in `scripts/`. This is the authority: when a document and the source
   disagree, the source wins.
2. **Runtime output of this build.** The generated `reference-index` document is
   produced by *running* each subcommand's own `--help` in this repository, so
   its usage blocks are the same bytes a user sees, interpolated constants
   included.
3. **This repository's own bundled prose.** The skill and subagent prompts under
   `src/agent/`, and the bundled `SKILL.md` files under `src/skills/builtin/`.
4. **Nothing else.** No hosted documentation, marketing copy, blog post, or
   third-party summary was read, fetched, or searched while authoring these
   documents — not for structure, not for wording, and not for the "does a page
   exist for this topic" step.

The structural rule follows from input 1: the generated index's organization is
derived from the subcommand tree in `src/cli/subcommands/router.ts` and the
slash-command registry in `src/cli/commands/registry.ts`, not from anyone's
table of contents.

## Authorship

| Item | Value |
| --- | --- |
| Produced | 2026-10-10 |
| Repository revision | `c0253ee5` |
| Produced by | an AI coding agent, at the maintainer's instruction, reading only the inputs listed above |
| Committed by | the repository maintainer |
| Human changes before commit | review and any correction the maintainer makes; the commit message records the change |

This is stated plainly because the repository's own contribution rules require
AI involvement to be disclosed rather than implied. A reader should treat these
documents as machine-derived from source and human-reviewed, not as a primary
source in their own right.

## Traceability audit

The claim "every statement is traceable to a source line" is only useful if it
is enforced, so it is:

```bash
node scripts/check-reference-citations.mjs
```

The script extracts every backticked repository path with an optional line or
line range from every document in this directory, and fails if a cited file does
not exist or a cited line is outside the file.

**Result at the recorded revision: 606 citations across 7 documents, all
resolving to real lines.**

Two limits of that audit, stated so nobody over-reads it:

- It checks existence and range, **not meaning**. A citation pointing at the
  wrong line inside the right file still passes. Matching wording to the cited
  line is a reviewer's job.
- It covers the hand-written documents and the generated index together; the
  generated index is additionally covered by its own regeneration check
  (`bun scripts/extract-haruyuki-reference.mjs`, which fails when the committed
  file no longer matches the command tree).

## Similarity audit

The audit looks for overlap rather than for intent, because "I was careful not
to copy" is not something a reader can verify.

**What was checked, and the result:**

| Check | Result |
| --- | --- |
| Long verbatim runs shared with any external text | None. No external text was an input, so there is no text to overlap with. |
| Verbatim strings that do appear | Only this repository's own strings, listed below. |
| Reused headings, ordering, or grouping from an external source | None. Structure is generated from this repository's command tree. |
| Figurative language or metaphors introduced as explanation | None. The documents describe mechanisms and cite them. |
| Illustrative examples, sample output, log excerpts | None were copied. Usage blocks are captured from this build at generation time. |
| Images, screenshots, diagrams | None; these are text-only documents. |
| Derivational claims ("adapted from", "based on") or borrowed version strings | None. |

**Deliberate, enumerated exceptions.** Verbatim wording exists in exactly two
places, and both are this repository quoting itself:

1. **Command and flag names are used exactly** — spelling, case, and hyphens
   unchanged. That is a correctness requirement: paraphrasing a flag produces a
   document that is wrong. The generated index additionally reproduces each
   subcommand's `--help` text because it captures it at runtime.
2. **The phrase "Memory Palace" appears once**, inside the generated index, as
   this repository's own description of the `/memory palace` command —
   `src/cli/commands/hubs.ts:149-152`. It is not used as an explanatory
   device anywhere in the hand-written documents; they describe what the command
   opens and cite the registry.

**Topics that cannot have an external counterpart**, because they describe
mechanisms that exist only here: the prefix freeze and its application points,
the compression-rate semantics of `/compact`, topic markers and block selection,
the local provider store, the harness root and its settings precedence, and the
local backend's storage layout. The remaining topics — memory filesystem, MCP,
channels, cron, compaction in general — are written against this build's
implementation, which has diverged from anything hosted: several of the
subcommands and routes those topics would otherwise discuss are simply absent
here, as the `unsupported` document records.

## Writing rules these documents follow

Kept as a checklist for the next person who adds a document here:

- **Facts, not essay.** Command names, arguments, defaults, enumerations,
  constraints, and behavior. Interpretation is limited to what the cited line
  says.
- **One source line per claim.** If a sentence cannot point at a file and line,
  it does not belong.
- **Command and flag names verbatim; everything else rewritten from source.**
- **No external inputs.** If a detail cannot be established from this
  repository, the correct answer is that it is not documented — not a plausible
  guess.
- **Keep the generated and the hand-written split.** The generated document is
  overwritten by its script; the hand-written ones are not. Do not hand-edit the
  generated one.

## Keeping this current

| When | Run |
| --- | --- |
| A subcommand, alias, `--help` line, or slash command changes | `bun scripts/extract-haruyuki-reference.mjs --write` |
| After editing any hand-written document | `node scripts/check-reference-citations.mjs` |
| Before publishing | both of the above, then `bun run check` |

A stale line number is not a cosmetic problem: it is the document's only claim
to authority, so the citation check is meant to fail loudly rather than quietly
drift.
