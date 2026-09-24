# Working in this repo

## Stress-test every change

After building or changing anything (code, pages, workflows, schema, scripts),
and before committing or pushing it, run the `stress-tester` agent
(`.claude/agents/stress-tester.md`). Give it what changed and what the change
is meant to do. Fix every finding it reproduces, then run it again until the
verdict is SHIP or SHIP WITH NOTES. Include its verdict and any open notes in
the summary to the user.
