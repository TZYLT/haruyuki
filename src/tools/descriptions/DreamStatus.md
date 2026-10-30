# DreamStatus

Report the current dream run's budget, progress and remaining room. Call it
before deciding whether to open new work, and again before wrapping up.

The report covers:

- the run id, trigger source and start time;
- status (`running` while the run is live);
- budget in tokens: total, spent, percent and remaining;
- the tier plan, the tier reached and the tiers still ahead;
- an estimated number of remaining steps (an estimate: the run record does not
  count steps, so the tool divides remaining tokens by a documented per-step
  estimate);
- elapsed time and, when a time limit is configured, the time left;
- the recorded handoff, if one exists yet, and a budget-based hint (continue,
  prefer finishing, wrap up, or stop and hand off).

The tool only reads the run record and the resolved settings. It does not change
the run, the budget, the memory repository or the conversation — checking status
is always safe, and it does not count against the budget.
