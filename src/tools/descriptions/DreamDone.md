# DreamDone

Finish the dream run and record where the next run should continue.

Call this **once**, when you are done — either because the planned work is
complete (`status: "done"`) or because you are stopping early (`status:
"handoff"`, for example when the budget is nearly spent or a task needs the
user). After this call, stop calling tools and write the report body as your
final message.

What this tool does:

- writes your `handoff` paragraph into the run record, where the finishing step
  and the next run read it;
- tells you to stop and write the final report body.

What this tool does **not** do:

- it does not commit memory. Commit your coherent changes with `MemoryCommit`
  **before** calling this tool; this call is the last thing in the run;
- it does not change the run's terminal status. The harness decides whether the
  run succeeded, ran out of budget or was cancelled.

If you have nothing left, say so in `handoff` rather than leaving it empty.
