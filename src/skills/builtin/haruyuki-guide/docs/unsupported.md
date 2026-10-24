---
title: What this build does not do
description: Hosted features that are absent from this build, what replaced them, and the strings that still name a hosted service.
applies_to:
  backends: [local]
  interfaces: [cli, desktop, sdk]
---

# What this build does not do

This build is local-first. Its state lives on disk under the harness home
directory and its memory is a git repository you own. Several features that a
hosted deployment offers have no counterpart here, and some of them left behind
command names, flags, or wording that could make an agent claim otherwise. This
document exists so those questions get a factual answer instead of a guess.

## There is one backend, and it is local

- `--backend` documents a single value. The help text is literally
  `Backend mode: "local"` — `src/cli/args.ts:125-132`.
- Startup configures the local backend unconditionally, with a comment saying it
  is the only one — `src/index.ts:410-413`.
- The default server URL is a self-hosted address, `http://localhost:8283`, and
  the source states that Cloud is deliberately not a default anywhere —
  `src/backend/api/server-url.ts:12`, `src/backend/api/server-url.ts:31-33`.
  Nothing reaches the network unless something is listening there.
- `isCloudServerUrl()` returns true only when the *configured* hostname matches
  the Cloud host, which now requires the user to point `LETTA_BASE_URL` at it —
  `src/backend/api/server-url.ts:42-58`.

Treat every "server" in this build as "the server you configured, default
localhost". A route can exist in the code without a hosted service behind it.

## Subcommands that were removed

These are not registered, and a regression test asserts each returns no
subcommand — `src/cli/subcommands/router.test.ts:130-151`:

`dream` (as a subcommand) · `computers` · `environments` · `envs` · `teleport` ·
`usage` · `permissions` · `shared-memory` · `feedback` · `remote` · `sandbox`

## Hosted capabilities with no local counterpart

The cloud-egress guard carries the authoritative list of modules whose only
purpose was reaching a hosted service, each with the route it used —
`scripts/check-cloud-egress.js:16-30`:

| Capability | Route it used | Status here |
| --- | --- | --- |
| Cloud agents context | `GET /v1/agents/:id/context` | removed |
| Conversation fork / summarize | `POST /v1/conversations` | removed |
| Cloud turn delivery | `POST /v1/agents/:id/messages` | removed |
| Environments, agent sandboxes | `GET/POST /v1/environments`, `POST /v1/agents/:id/sandboxes` | removed |
| One-shot generate | `POST /v1/agents/:id/messages` | removed |
| Hosted health probe | `GET /v1/health` | removed |
| Billing tier, balance, quotas | `GET /v1/metadata/*` | not a feature here |
| Cloud reflection config and run records | `GET/PATCH` reflection routes | reflection is Code-managed locally |
| Cloud sandbox file IO | sandbox file routes | removed |
| Cloud schedules | schedules routes | `haruyuki cron` is the only scheduler |
| Internal search cache warm | `POST /v1/_internal_search/cache-warm` | removed |

Reflection is worth calling out because a function name still says "Cloud":
`requestCloudReflectionRun` returns `null` for the local backend, and that
`null` is what authorizes the local Code-managed path rather than acting as an
error fallback — `src/agent/reflection-runs.ts:8-25`.

Teleport, shared memory, and cloud computers were removed outright; the
`teleport` subcommand test above is the check that they stay gone.

## Feedback is written to a local file

`/maintenance feedback` does not transmit anything. `submitFeedbackMetadata`
appends the report to a JSONL log on disk so you can attach it to an issue
yourself — `src/backend/api/metadata.ts:55-70`, and the sink is
`appendLocalFeedback` from `src/telemetry/local-feedback-log.ts:53-57`. The file
is `~/.haruyuki/logs/feedback.jsonl` and rotates at 10 MB with 10 files
retained — `src/telemetry/local-feedback-log.ts:20-26`. Note that this path is
built from the OS home directory rather than from the harness-root resolver, so
it does **not** move when `HARUYUKI_HOME` is set —
`src/telemetry/local-feedback-log.ts:16-20`.

The command description points at this repository's own issue tracker instead of
a hosted support channel — `src/cli/commands/registry.ts:499-506`. There is no
hosted status page and no support community for this build.

## Flags and wording around removals

One flag survives and is easy to misread; one piece of wording did not survive
and is worth knowing about. Both are covered here rather than in the command
reference, because the honest answer is "this is what it says, this is what it
does".

- **`--computer <selector>`** still exists and still describes routing a
  headless message to an environment connection "on the configured server" —
  `src/cli/args.ts:206-214`. With the default server URL that means your own
  `haruyuki server`; it is not a hosted fleet.

`/usage` no longer carries the old "session usage statistics and balance"
wording: it is an ordinary page command that opens the local Usage page
(overview and breakdown) in the full-screen shell. No balance is read, so a
local-only install has no balance to show.

Some source strings still name hosted hosts, and none of them is a runtime
route: the Slack presenter builds viewer links against the hosted chat host
(`src/channels/slack/presentation.ts:31`), and the app-URL helper does the same
for desktop sessions (`src/cli/helpers/app-urls.ts:3`).

## Surfaces that are not the CLI

Distinguish the terminal UI from the other two surfaces before answering an
affordance question:

- **`desktop`** — the app-server surface. `haruyuki server` serves it locally;
  the protocol is the one other clients compile against.
- **`sdk`** — the programmatic client entry points.

A feature being absent from the terminal UI does not mean it is absent from the
app-server, and the reverse is also true.
