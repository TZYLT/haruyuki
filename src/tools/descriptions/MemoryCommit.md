Commit changes to your memory repository.

This is the dream run's only way to make memory edits durable: it stages the
given paths and creates a git commit in your own memory repository, without a
shell. Use it whenever you finish a coherent change — after tidying a folder,
after adding or merging notes, after writing a conclusion worth keeping.

- `paths` are relative to the memory repository root (`MEMORY.md`,
  `projects/acme/notes.md`, `maintenance`). Only changed paths are committed;
  nothing outside the repository, and nothing under `.git`, is accepted.
- `reason` is the commit subject. Say what changed and why, in one line.
- If the given paths have no changes, the tool reports "nothing to commit"
  instead of failing.
- Commit in small, reviewable steps rather than once at the very end: the run's
  baseline is a commit, and one-step rollback to it is only useful when the
  history between them explains what happened.
- Do not try to run git yourself: this run has no shell, and this tool is the
  supported path.
