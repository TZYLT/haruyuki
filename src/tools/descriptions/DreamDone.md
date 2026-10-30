# DreamDone

Finish the whole dream run and record what is left for the report.

Call this **once**, when the run as a whole is ending — either because the planned
work is complete (`status: "done"`) or because you are stopping early (`status:
"handoff"`, for example when the budget is nearly spent or a task needs the
user). Do **not** call it at the end of a single tier's turn: the harness starts
the next tier automatically, and `DreamDone` ends the run. After this call, stop
calling tools and write the report body as your final message.

What this tool does:

- writes your `handoff` paragraph into the run record, where the finishing step
  includes it in `maintenance/dream-report.md`. A later run can read that report
  if it needs the context; there is no automatic handoff message between runs;
- tells you to stop and write the final report body.

What this tool does **not** do:

- it does not commit memory. Commit your coherent changes with `MemoryCommit`
  **before** calling this tool; this call is the last thing in the run;
- it does not change the run's terminal status. The harness decides whether the
  run succeeded, ran out of budget or was cancelled.

If you have nothing left, say so in `handoff` rather than leaving it empty.
