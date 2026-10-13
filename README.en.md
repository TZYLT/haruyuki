# Haruyuki

English · [简体中文](README.md)

> [!WARNING]
> **AIGC disclosure and usage warning**
>
> Much of this project's **code and documentation was produced with AI assistance** (AI drafting, with
> review, decisions, and verification by the human maintainer). The commit history, [`NOTICE`](NOTICE),
> and [CONTRIBUTING.md](CONTRIBUTING.md) record the origin, reasoning, and verification of each change.
>
> - **It can be wrong**: AI-generated material may contain **logic errors, stale information, security
>   flaws, and similar risks**. This project is provided **"AS IS"**; review, test, and assess the risk
>   yourself before using or redistributing it. The developer is not liable for data loss or other damage
>   arising from the project's logic errors.
> - **Reuse and quotation**: if your jurisdiction or platform requires labelling AI-generated content,
>   please **keep this disclosure** when you quote, screenshot, or reuse this project's content.
> - **Not an official release**: this is not an official Letta, Inc. product and has not been reviewed,
>   tested, or endorsed by them (see [§8](#8-license-and-legal-notices)).
> - **If you find a problem**: report it on this project's [issue tracker](https://github.com/TZYLT/haruyuki/issues).
>   A `/feedback` report is written to a local log only; it is never sent there automatically.
> - I am currently the only developer, and I am working through the code by hand to review and clean it up.
>   Please bear with me — my time and ability are limited. If you would like to contribute, a pull request
>   on GitHub is very welcome. Thank you.

This fork is **not affiliated with, sponsored by, or endorsed by Letta, Inc.**; the names "Letta" and
"Letta Code" are used **only to describe the origin of the code**. Related brand marks and names are
neither used nor distributed (upstream's Brand Assets Exclusion). Legal notices live in [NOTICE](NOTICE),
third-party licences in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md); the infringement contact is in
[§8 → No affiliation, rights notices, and infringement contact](#no-affiliation-rights-notices-and-infringement-contact).

I (the developer) have tried my best to follow the licence terms the original project requires, but
oversights are inevitable given my limited ability. If this project infringes your rights, please do
contact me so we can resolve it.

## 1. What this project is

**Haruyuki is a local-first, cost-conscious agent runtime — a heavily modified fork of `letta-code`.**

Haruyuki is an agent runtime that runs on **your own machine**. It asks you to sign in to nothing and keeps
no state anywhere else: everything is local and self-held.

Haruyuki treats an agent's memory, identity, and behaviour as **assets that evolve over the long term**: a
multi-layer, self-held memory system versioned as a git-backed file tree, with reflection agents running as
an independent background mechanism that organises your conversation memory. System prompts and tool lists
can be reloaded on demand, and context can be trimmed freely along topic boundaries — with your wallet in
mind.

We work on making both the experience and the cost better, and have introduced a great many new mechanisms
to that end.

### Goals

| Goal | What it means |
|---|---|
| **Companionship, not just a tool** | A single agent you live with over time: it remembers, has a stable self, and continues across sessions — not a question-answering window that starts from zero every time |
| **Cost-first design** | Every feature weighs cost first, aiming for the best balance between cost and experience |
| **Radical local self-holding** | State, memory, logs, and keys all live on your own filesystem; it works completely without any cloud service |
| **Unconstrained independent development** | A **complete separation** from upstream since `v0.34.2` (no upstream merges, no cherry-picks), so structural work is possible — for example tree-shaped memory, vector recall, and conversation-fork archiving |
| **Project discipline** | No mirroring of upstream documentation; every change relative to upstream is itemised in [CONTRIBUTING.md](CONTRIBUTING.md), and we try hard not to let the project rot |

### Highlights

| Highlight | Description |
|---|---|
| **Prefix freezing** | Changes to prompts, tools, or memory **never silently rewrite context already sent**, so you don't wake up to a terrifying bill; `/context-pending` shows what is queued, `/recompile` applies it explicitly |
| **Topic trimming** | `/topic`, `/topics`, `/compact` — trim context along topic boundaries you choose, instead of dropping the tail proportionally |
| **Memory as a file tree** | MemFS: all context (including memory blocks) is tracked by git — diffable, revertible, and pushable to your own remote |
| **Passive memory** | A reflection agent runs alongside you and organises memory itself; `/reflect`, `/dream`, and `/sleeptime` control when it fires |
| **Local backend** | A single backend mode (`--backend local`): agent, conversations, memory, and transcripts all live on this machine |
| **Multi-agent** | Any agent can act as another agent's subagent (including built-in subagents such as fork and recall) |
| **Channels and a local server** | `haruyuki server` provides a local app-server, WebSocket, and Slack/Telegram channels |
| **Fully local diagnostics** | No telemetry; crashes, boundary errors, and `/feedback` are written to local logs only |

## 2. What changed relative to upstream

> **This is only a summary. The itemised list of changes (with the reasoning and trade-offs behind each)
> lives in [CONTRIBUTING.md](CONTRIBUTING.md#相对上游的改动清单) (Chinese).**

1. **Cloud features removed wholesale**: the Letta Cloud backend and login, teleport, remote-computer and
   environment routing, hosted sandboxes, hosted schedules, shared memory, usage and quota switching, and
   the cloud-dependent feature skills.
2. **Outbound paths cut**: telemetry and third-party error/feedback reporting are gone; diagnostics are
   written to local log files instead.
3. **Renames**: the package name, the executable, the config directory (`~/.haruyuki`) and the environment
   variable prefix (`HARUYUKI_*`). Only eight names that are bound to the upstream SDK contract
   **deliberately keep the `LETTA_` prefix**.
4. **Brand and assets held by the fork**: its own palette and mark; the upstream ASCII art on the OAuth
   callback page has been removed and replaced with the fork's own mark, and the bundled default avatar has
   been replaced with an original image.
5. **Mechanism changes and additions**: prefix freezing, topic trimming, background reflection, the local
   backend and memory sync, and more (see the highlights table above).
6. **Documentation held by the fork**: no mirroring of upstream documentation text; this README plus
   [CONTRIBUTING.md](CONTRIBUTING.md) and [NOTICE](NOTICE) are the authoritative explanation.

## 3. Install

Requirements: **Bun ≥ 1.3.2** (to build) and **Node ≥ 22.19** (to run the built artifact).

### Option 1 — build from source

```bash
git clone <this repository>
cd Haruyuki
bun install
bun run build        # produces haruyuki.js at the repo root (gitignored)
node ./haruyuki.js   # start the interactive UI
```

> The build output is a **single-file bundle** (~21 MB) with production dependencies inlined;
> `--version` should print `0.2.0 (Haruyuki)`. The number comes from `package.json`'s `version`
> and is **inlined at build time**, so changing it requires a rebuild.

### Option 2 — the npm package (recommended)

```bash
npm install -g haruyuki         # or npx haruyuki
npm install -g haruyuki@beta    # pre-release
```

> The `haruyuki` package on npm is published by this fork's maintainer and is **not** an official Letta,
> Inc. release. It ships `LICENSE`, `NOTICE`, `THIRD-PARTY-NOTICES.md`, and `CONTRIBUTING.md` (the change
> list).

### The short name `hryk`

The CLI answers to **both** `hryk` and `haruyuki`; the two are equivalent and behave identically, and
user-facing text always prints the long name. Whether the short name is *available* depends on how you
installed it:

| How you installed | Commands you get |
|---|---|
| Built from source, or installed from the packaged tarball | `haruyuki` **and** `hryk` |
| `npm install -g haruyuki` (the registry) | **`haruyuki` only** |

npm generates a global command from the **package name in the registry**, and this package is named
`haruyuki` there, so only the `haruyuki` shim is created. A separate `hryk` package was designed and
built, but the registry **rejected the name as too similar to existing packages** (403, conflicting with
`hoek` and others), so the short name is not offered through the registry.

## 4. Quick start

- Connect a model API:

```bash
haruyuki connect openai        # or anthropic / z.ai / etc.; you will be prompted for an API key
# or use /connect inside a session
```

- Start it up:

```bash
haruyuki                                      # interactive TUI: resume this project's last conversation
haruyuki --new-agent --personality tutorial   # create a tutorial agent
haruyuki --new                                # new conversation (keeps agent memory)
haruyuki -p "describe yourself in one sentence" --output-format json   # headless, with stats
```

Inside an interactive session, start with `/help`, `/init` (initialise memory), `/model` (switch model),
`/skills`, and `/doctor`.

[Common commands reference (Chinese)](https://github.com/TZYLT/haruyuki/blob/main/docs/commands.zh-CN.md)

## 5. Platform notes and known limitations

| Item | Notes |
|---|---|
| Windows | **Automatic reflection is off by default** (including a saved `/sleeptime` setting); manual `/reflect` and `/dream` work. To enable it, set `HARUYUKI_ENABLE_WINDOWS_AUTO_REFLECTION=1` in the process that starts Haruyuki |
| Sandboxing | Kernel-level filesystem sandboxing is available only on macOS (seatbelt) and Linux (bwrap); **Windows has no kernel backend** (a code fact — see `src/sandbox/availability.ts`), so the cross-agent memory fence falls back to a static path guard |
| Legacy flags | `--computer`, `--no-wait`, `--memfs-startup` and similar are still in the help output (upstream compatibility surface); this fork does not promise their cloud semantics work |
| Multiple platforms untested | This project is developed on Windows and I have no other machines to test on. If you hit a problem, please open an issue |

## 6. Roadmap and contributing

The project is under active development with a large backlog of changes queued. If you disagree with
something or want to contribute, a pull request is very welcome.

**To do:**
- [x] Prefix freezing → raise cache hit rate and cut cost substantially
- [x] Topic markers → freer context trimming
- [ ] Passive memory recall → improve answer accuracy while saving a little cost
- [ ] Single-conversation mode → a continuous, unified conversation experience
- [ ] Repackage the GUI → a clean, fast graphical interface
- [ ] Network access and a web UI
- [ ] Downstream polish (voice synthesis, character art, and so on)
- [ ] Stable personality and conversational style

## 7. Your data, logs, and privacy

- All agent state, memory, and transcripts live in `~/.haruyuki` (or wherever `HARUYUKI_HOME` points) and
  in your own provider account; this project **never** reports telemetry and **never** sends diagnostic
  content to a third party.
- Crash/boundary-error logs and `/feedback` reports are written to local files (`~/.haruyuki/logs/`).
- `haruyuki memory backup` takes a snapshot before you touch memory, and the memory directory is itself a
  git repository, so every change has a commit — see
  [the common commands reference (Chinese)](https://github.com/TZYLT/haruyuki/blob/main/docs/commands.zh-CN.md).
- The eight `LETTA_*` environment variables shared with upstream only affect the reading of **local paths
  and provider credentials**; they cause no outbound calls.

## 8. License and legal notices

### License

This project is licensed under the **Apache License 2.0** — see [LICENSE](LICENSE).
That file is the upstream text, redistributed verbatim, and it contains two parts that must be kept:

1. `Copyright 2025, Letta authors` — the upstream copyright line;
2. the **Brand Assets Exclusion** — the Letta name, Letta Code name, logo, wordmark, **images**, and **ASCII
   art** are explicitly **not** licensed under Apache-2.0 and may not be used in derivative works without
   written permission from Letta, Inc.

### This is a modified version

This repository is a **derivative work** of `letta-code`; its source files have been changed, and the change
list is in [CONTRIBUTING.md](CONTRIBUTING.md#相对上游的改动清单). As required by Apache-2.0 §4(b), the
**repository-level "changed files" notice** lives in [NOTICE](NOTICE) and in this section rather than being
repeated in every individual file.

Upstream ships **no** `NOTICE` file; the one in this fork is added by the fork and must be kept by downstream
recipients.

**Scope of the copyright claim**: this fork claims copyright **only over its own additions and
modifications** (`Copyright 2026 TZYLT`), never over the repository as a whole; the upstream portions remain
`Copyright 2025, Letta authors`. The claim rests on **the maintainer's intellectual contribution** —
architecture and design, selection and arrangement, review and correction. AI is a tool in this project and
**does not waive any right**; the AIGC disclosure is a labelling statement, not a disclaimer. See
[NOTICE](NOTICE) §1, "Scope of the copyright claim".

### Third-party components

`haruyuki.js` is a single-file bundle that inlines most production dependencies, and `vendor/` carries two
patched third-party sources (Ink and ink-text-input). Their license texts, every package's copyright line,
the result of the NOTICE-file scan over the closure, and the **non-npm** third-party material — the three
external system prompts under [`src/agent/prompts/`](src/agent/prompts/README.md) (Claude Code, Codex CLI,
and Gemini CLI) collected for benchmarking — are itemised in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md); that file is generated by
`node scripts/generate-third-party-notices.cjs`, so regenerate it whenever dependencies change.

The `@letta-ai/*` packages inside the dependency closure are published by Letta, Inc. as separate npm
packages; the assets they ship are not part of this project's distribution.

### Trademarks and brand assets

"Letta", "Letta Code", and the Letta logo are trademarks and/or brand assets of Letta, Inc. They are used
here only to identify the origin of the code (nominative use) and to satisfy Apache-2.0's attribution
requirements. Using this project grants you no rights to the Letta marks.

To comply with the Brand Assets Exclusion, this fork **neither uses nor distributes** any Letta logo,
wordmark, brand image, or brand ASCII art.

### No affiliation, rights notices, and infringement contact

This project is independently maintained by a third party (TZYLT, `TZY143@126.com`) and has **no affiliation,
partnership, sponsorship, or endorsement relationship with Letta, Inc.** Upstream provides no warranty and
no support for anything in this fork.

This fork is a third-party modified version of `letta-code`. If you are a rights holder and believe that any
content in this repository infringes your rights, please write to:

> **TZY143@126.com**

To speed things up, please include:
- who you are and the rights you rely on;
- the exact location of the material (file path, line number, or URL);
- what you would like us to do (remove, replace, add attribution, …).

We will **act promptly once the claim is verified**: remove or replace the material, or point to a
verifiable licence. Pending clarification, the affected files can be taken down first. This fork does **not**
mirror any `docs.letta.com` documentation text and does not use any Letta brand asset — if something was
missed, tell us and we will handle it the same way.

### Disclaimer

The software is provided **"AS IS"**, without warranty of any kind. You are responsible for your model
provider's terms and costs, for your own data compliance, and for the behavioural differences between this
fork and upstream.

## 9. Upstream and credits

Haruyuki is derived from [letta-code](https://github.com/letta-ai/letta-code), built by the authors of
[MemGPT](https://arxiv.org/abs/2310.08560) and [sleep-time compute](https://arxiv.org/abs/2504.13171) (now
called "dreaming"). Upstream code is licensed under Apache-2.0, and this fork is grateful for it. Apart from
attribution and technical identifiers, this project has no relationship with upstream.
