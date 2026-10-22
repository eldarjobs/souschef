---
name: delegate-tests
description: Hand test writing to a second coding agent (Antigravity CLI, agy) through the souschef MCP tools, follow the run live, and act on its findings. Use when you have finished implementing or changing code and it needs tests, when the project's instructions say tests are written by another agent, or when the user asks to delegate tests to Antigravity, agy or a tester agent.
---

# Delegate tests to the tester agent

You implement; the tester agent writes and runs the tests. Do not write the test files yourself
while this workflow is in use.

## 1. Check the agent (once per session)

Call `doctor` with `cwd` set to the absolute project root. If `signed_in` is false or `binary` is
null, tell the user what the `hints` say and stop: nothing below works until that is fixed.
Check `project.test_command` and `project.write_globs`. If they are wrong for this project, either
pass `test_command` / `write_globs` to `start_run`, or suggest adding `.souschef.json` to the
project root:

```json
{ "test_command": "...", "write_globs": ["tests/**"], "rules": ["..."], "timeout_minutes": 60 }
```

## 2. Brief the agent

Call `start_run` with:

- `feature`: one line on what changed.
- `changed_files`: the production files you touched.
- `requirements`: one concrete, checkable behaviour per item, as you would brief a colleague who
  has not seen the code. Name the input, the expected outcome and the edge cases, e.g.
  "OperatesOn('135', a Wednesday) returns true: the digits are a set, not positions". Cover the
  failure paths (which exception, which message) as well as the happy path. Put placement and run
  instructions first, as `SETUP: ...` and `RUN: ...` items, when the project needs them.
- `cwd`: the absolute project root.

Tell the user in one line that the run started, with its run_id.

## 3. Follow it live

Call `wait_run` with the run_id and the `cursor` from the previous answer, again and again, while
`state` is `running`. After each answer, give the user one short line on what moved (files
written, elapsed time). Do not edit the files under test meanwhile: the agent is reading them.

## 4. Act on the result

- `passed`: report the summary and the test files added.
- `failed`: read `result.suspected_source_bugs` and `result.failures`.
  - For each suspected source bug, read the production code and decide who is right. If the code
    is wrong, fix it. If the requirement was wrong, say so in the feedback.
  - Then call `continue_run` with feedback that names what you fixed and which tests to re-run, or
    which tests are wrong and why. Follow the new run_id as in step 3.
  - Stop after three follow-ups and hand the rest to the user.
- `error` / `timeout`: show `reason`. If the agent printed nothing, run `doctor`.
- `out_of_scope` is not empty: the agent changed files outside the test folders. Show the user
  the list. Do not revert them without asking.

Always finish with what was tested, what passed, what you changed in production code, and what
is still open.
