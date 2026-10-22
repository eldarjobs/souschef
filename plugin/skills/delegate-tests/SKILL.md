---
name: delegate-tests
description: Hand test writing to a second coding agent (Antigravity CLI, agy) through the souschef MCP tools. SousChef runs it in an isolated workspace, builds and runs the tests, rejects changes outside test files, applies verified tests to the checkout and returns a compact report. Use when you have finished implementing or changing code and it needs tests, when the project's instructions say tests are written by another agent, or when the user asks to delegate tests to Antigravity, agy or a tester agent.
---

# Delegate tests to the tester agent

You implement; the tester agent writes the tests. Do not write test files yourself while this
workflow is in use. The point is to keep test code and test logs out of your context: read the
compact report, and ask for diffs or logs only when something specific needs them.

## 1. Check the setup (once per session)

Call `doctor` with `projectRoot` set to the absolute project root. If `agent.ok` is false, tell
the user what `agent.detail` says and stop. If `tests.problem` is set, SousChef could not pick a
test command safely: show the problem and suggest a `.souschef.json` in the project root, e.g.

```json
{ "test": { "executable": "dotnet", "args": ["test", "App.sln"], "cwd": "." }, "writeGlobs": ["tests/**"], "rules": ["..."] }
```

## 2. Delegate

Call `delegate_task` with:

- `taskType`: `"tests"`.
- `projectRoot`: the absolute project root.
- `targetPaths`: the production files you changed (relative paths).
- `objective`: concrete, checkable behaviour, as you would brief a colleague who has not seen the
  code: inputs, expected outcomes, edge cases and failure paths (which exception, which message).
  Put placement instructions first ("Put the tests in tests/Orders/...").
- `module`: only in a monorepo whose targets live in one module.

Uncommitted changes are included automatically; you do not need to commit first. Tell the user in
one line that the task started, with its taskId.

**Live view.** The answer carries `watch`, a command that prints every step the tester takes (files
it writes, commands it runs, what it says) until the task ends. If you can open a terminal tab beside
the chat (for example a `run_in_terminal` tool), run `watch` there right away, titled `souschef`, and
tell the user it is open. Otherwise give them the command to paste into a terminal. Watching never
affects the task, and Ctrl+C only stops the view.

## 3. Wait

Call `wait_for_task` with the taskId until `finished` is true. After each call, give the user one
short line with `phase` and the newest line of `recent` (the latest steps). Do not edit files under
test meanwhile.

## 4. Act on the result

Call `get_task_result` (no `include`). Then:

- `COMPLETED`: report `summary` and `changedFiles`. If `apply.applied` is false, say why
  (`apply.reason`).
- `NEEDS_REVIEW` with `agent.suspectedProductBug`: the tests point to a bug in your code. Read
  `reason`, then the production code, and decide who is right. If the code is wrong, fix it and call
  `delegate_task` again with `continueFrom: <taskId>` and an `objective` that says what you fixed.
  If the expectation was wrong, say so in the follow-up objective instead.
- `NEEDS_REVIEW` with `security.outOfScopeChanges` > 0: the agent touched files outside the test
  paths; nothing was applied. Show `security.violations` to the user.
- `NEEDS_REVIEW` with `apply.conflicts`: the checkout changed while the task ran. Ask the user
  whether to re-run.
- `FAILED`: read `reason`. Only if it is unclear, call `get_task_result` with
  `include: ["testOutput"]` (or `buildOutput`) for the tail of the log.
- `TIMED_OUT` / `CANCELLED`: report it; re-run only if the user wants to.

Use `get_task_diff` only when you need to see what the agent wrote (one `path` at a time for big
diffs). Stop after three follow-ups and hand the rest to the user.

Always finish with what was tested, what passed, what you changed in production code, and what is
still open.
