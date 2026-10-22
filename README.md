# souschef

**Your agent cooks. Souschef tastes.**

In a kitchen, nothing leaves the pass until the sous-chef has tasted it. souschef brings that to
coding agents: when your agent finishes a change, a *second* agent writes the tests, souschef
runs them, checks that only test files changed, and hands back a short report. It also catches
bugs in your code, not just in the agent's tests.

souschef is an MCP server, packaged as a Claude Code plugin. It hands test writing to a headless
coding agent (today the [Antigravity CLI](https://antigravity.google), `agy`) and keeps the noise
(test code, terminal logs, the agent's conversation) out of your main agent's context unless it
asks for it.

```
Claude Code                       souschef                                  agy (headless)
delegate_task(objective) ──────▶  snapshot checkout (incl. uncommitted work)
◀── taskId                        isolated git worktree ──────────────────▶ writes tests
wait_for_task ◀── RUNNING         build + test (allow-listed commands)
                                  failing? resume same conversation ──────▶ repairs test code
                                  scope check: only test paths changed?
                                  conflict check, apply tests to checkout
get_task_result ◀── {"status":"COMPLETED","tests":{"passed":12,"failed":0},...}
```

## Install (Claude Code)

```
/plugin marketplace add https://github.com/eldarjobs/souschef.git
/plugin install souschef@souschef
```

Use the full HTTPS URL. The `eldarjobs/souschef` shorthand clones over SSH, which fails with
"Host key verification failed" on machines without an SSH key set up for GitHub.

Local checkout:

```
claude plugin marketplace add /path/to/souschef
claude plugin install souschef@souschef
```

The server is one self-contained file (`plugin/dist/server.cjs`), so the plugin needs no
`npm install`. It needs Node 22.13+ (for the built-in SQLite) and git.

### Other MCP clients

```json
{ "mcpServers": { "souschef": { "command": "node", "args": ["/path/to/souschef/plugin/dist/server.cjs"] } } }
```

## The tester agent

Install the Antigravity CLI, run `agy` once in a terminal and sign in. souschef finds it on PATH,
in the installer's default location, or at `SOUSCHEF_AGY`. `doctor` with `ping: true` proves it
works by sending it a one-word prompt.

## Use

Ask Claude to test what it just built, or run `/souschef:taste [scope]`. The bundled
`delegate-tests` skill does the rest.

### Tools

| Tool | What it does |
|---|---|
| `delegate_task` | Starts a task (`taskType: "tests"`) and returns a `taskId` at once. `continueFrom` resumes an earlier task's agent conversation with new feedback. `idempotencyKey` makes retries safe. |
| `get_task_status` | Status, phase and a one-line progress note. |
| `wait_for_task` | Blocks until the task finishes or a timeout passes. |
| `get_task_result` | The compact report. Logs (`testOutput`, `buildOutput`, `agentResponse`) only via `include`. |
| `get_task_diff` | The patch, size-limited; large ones are listed per file and paged. |
| `cancel_task` | Stops the task and only the processes souschef started for it. |
| `doctor` | Agent binary, config validity, git state, detected test command. |

A task moves through `CREATED → QUEUED → RUNNING ⇄ VALIDATING` and ends in `COMPLETED`,
`NEEDS_REVIEW`, `FAILED`, `CANCELLED` or `TIMED_OUT`. The agent exiting cleanly is never enough
on its own: build, tests and the scope check decide.

Report example:

```json
{
  "taskId": "task_mvj6arlr5377a5",
  "status": "COMPLETED",
  "execution": "PASSED",
  "build": "SKIPPED",
  "tests": { "command": "npm test --silent", "created": 6, "passed": 6, "failed": 0, "exitCode": 0 },
  "security": { "status": "PASSED", "outOfScopeChanges": 0 },
  "apply": { "applied": true },
  "changedFiles": ["test/math.test.js"],
  "agent": { "name": "antigravity", "attempts": 1, "usage": { "totalTokens": 48211 } },
  "summary": "Created 6 tests; tests passed (6 passed, 0 failed). Applied 1 file(s) to the checkout."
}
```

Tasks and results live in SQLite (`~/.souschef/souschef.db`), so they survive a server restart.

### Project config (optional)

`.souschef.json` at the project root:

```json
{
  "test": { "executable": "dotnet", "args": ["test", "MySolution.sln", "--filter", "Category!=Integration"], "cwd": "." },
  "build": { "executable": "dotnet", "args": ["build", "MySolution.sln"], "cwd": "." },
  "writeGlobs": ["tests/**"],
  "rules": ["Use xUnit and Moq", "No tests that need a real database"],
  "maxRepairAttempts": 2,
  "autoApply": true,
  "agent": { "model": "...", "effort": "high", "permissionMode": "skip-permissions" }
}
```

Without it, souschef looks for the manifest nearest to the target files: .NET (`*.sln`, test
projects), Node (`package.json` test script; npm, pnpm, yarn, bun from the lockfile), Python
(pytest; uv, poetry or a local `.venv`), Go and Rust. If that is ambiguous (two solutions, targets
in two modules, no test script), it says so instead of guessing. In a monorepo, pass `module` or
list `modules` in the config. v1 keys (`test_command`, `write_globs`, `timeout_minutes`) are still
read.

## Safety

- **Isolation.** The agent works in a temporary git worktree (or a copy, for non-git projects).
  Your uncommitted changes are copied in, so the agent tests what you have now. Your checkout is
  not touched while it runs. `node_modules` / `.venv` are linked in, not copied.
- **Scope check.** Every changed path is checked against `writeGlobs` and a protected list
  (manifests, lockfiles, CI, `.env`, keys), plus path traversal and symlinks. Any violation means
  `NEEDS_REVIEW` and nothing is applied. Deleting tests is not allowed by default; edited existing
  tests are listed in `modifiedExistingTests`.
- **Apply.** Only verified, test-only changes are copied back, only if the same files have not
  changed in your checkout meanwhile, and only once. Nothing of yours is ever rolled back.
- **Commands.** Test commands run without a shell from an executable allow-list, with timeouts and
  output limits. Repository git hooks are disabled for souschef's own git calls.
- **Processes.** Cancel and timeouts kill only process trees souschef started, by PID.
- **Secrets.** API keys, tokens and secret-looking env values are redacted from stored logs.

The agent runs with `--dangerously-skip-permissions` by default, because print mode has nobody to
approve tool calls. A worktree is not an OS sandbox: use `permissionMode:
"skip-permissions-sandboxed"` for agy's terminal sandbox, and run souschef only on projects where
an agent executing code is acceptable.

## Develop

```
npm install
npm run typecheck
npm test           # unit + integration tests (a fake agent drives real git repos)
npm run build      # bundles src/ into plugin/dist/server.cjs
npm run smoke      # real end-to-end run against agy on a throwaway project (a few minutes)
```

Adding a backend means implementing `AgentAdapter` (`src/adapters/agent-adapter.ts`): find the
binary, run one headless turn, return status, structured output, usage and a conversation id.

## License

MIT
