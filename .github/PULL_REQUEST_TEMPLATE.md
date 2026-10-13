<!--
  Keep this short. It is read at the moment of opening a PR, not studied.
  The rules below are the ones a stranger cannot guess from the diff.
-->

## What this changes

<!-- One paragraph. If it fixes an issue, link it. -->

## Checklist

- [ ] `bun run check` passes locally (14 checks; CI runs the same command).
- [ ] This PR is **one logical change**. Unrelated cleanups are separate PRs.
- [ ] Commits are new commits — nothing amended, nothing force-pushed.
- [ ] If this touches streaming, approvals, queueing or interrupts, I checked the
      affected paths: interactive TUI, headless, and the websocket listener are
      three separate orchestrations and do not share everything.
- [ ] If this adds or changes something relative to upstream, I appended it to
      `CONTRIBUTING.md` §相对上游的改动清单.
- [ ] If this changes behaviour that `AGENTS.md` describes, I updated `AGENTS.md`
      in the same PR (documents and code must not disagree).
- [ ] I did not commit generated artifacts (`haruyuki.js`, `haruyuki.js.map`, `dist/`, `skills/`).

## Verification

<!--
  How do you know it works? "ran the tests" is weaker than naming the file.
  If a check cannot be run on this machine (platform-specific tests, npm page
  rendering), say so explicitly instead of implying it was verified.
-->

## Notes for the reviewer

<!-- Anything surprising, any deliberate deviation, anything you are unsure about. -->
