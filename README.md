# souschef

**Your agent cooks. Souschef tastes.**

In a kitchen, nothing leaves the pass until the sous-chef has tasted it. souschef brings that to
coding agents: when your agent finishes a change, a *second* agent writes the tests, runs them and
tells you what is wrong, and that includes bugs in your code, not just in its tests.

souschef is an MCP server, packaged as a Claude Code plugin. It hands test writing to a headless
coding agent (today the [Antigravity CLI](https://antigravity.google), `agy`), follows the run
live, and brings back a structured report: tests added, failures, and suspected bugs in the code
under test. You fix them and send feedback into the same agent conversation until the suite is green.

```
Claude Code                        souschef                            agy (headless)
start_run(feature, requirements) ─▶ writes brief.md, starts agy ───────▶ writes tests, runs them
wait_run(cursor) ◀─ events ──────── watches git status every 3 s
                                    "file: test/math.test.js"
wait_run(cursor) ◀─ state=failed ── reads result.json  ◀─────────────── result.json
  suspected_source_bugs: isEven
fix the code
continue_run(feedback) ───────────▶ agy --conversation <same id> ──────▶ re-runs, reports passed
```

That exact round trip, a planted bug found and then confirmed fixed, is what `npm run smoke`
runs against the real agent.

## Install (Claude Code)

```
/plugin marketplace add eldarjobs/souschef
/plugin install souschef@souschef
```

Local checkout:

```
claude plugin marketplace add /path/to/souschef
claude plugin install souschef@souschef
```

The server is one self-contained file (`plugin/dist/server.cjs`), so the plugin needs no
`npm install`. It needs Node 18+ and git.

### Other MCP clients

```json
{ "mcpServers": { "souschef": { "command": "node", "args": ["/path/to/souschef/plugin/dist/server.cjs"] } } }
```

## The tester agent

Install the Antigravity CLI, run `agy` once in a terminal and sign in. souschef finds it on
PATH, in the installer's default location, or at `SOUSCHEF_AGY`. The `doctor` tool proves it
works by sending it a one-word prompt.

## Use

Ask Claude to test what it just built, or run `/souschef:taste [scope]`. The bundled
`delegate-tests` skill does the rest: brief, start, follow, fix, follow up.

### Tools

| Tool | What it does |
|---|---|
| `doctor` | Is the agent installed and signed in? What test command and test folders were detected? |
| `start_run` | Writes the brief and starts the agent in the background. Returns a run id and cursor. |
| `wait_run` | Blocks until there is news (a file written, the run ending) or a time limit, then returns new events. Ending answers carry the agent's report. |
| `continue_run` | Follow-up in the same agent conversation, e.g. "I fixed isEven, run again". |
| `cancel_run` | Stops the agent and everything it started (by PID). |
| `list_runs` | Recent runs in this project. |

### Project config (optional)

`.souschef.json` at the project root:

```json
{
  "adapter": "agy",
  "test_command": "dotnet test MySolution.sln --filter \"Category!=Integration\"",
  "write_globs": ["tests/**"],
  "rules": ["Use xUnit and Moq", "No tests that need a real database"],
  "timeout_minutes": 60
}
```

Without it, souschef detects .NET (`*.sln`, `*.csproj`), Node (`package.json` test script; npm,
pnpm, yarn, bun), Python (pytest), Go and Rust, and picks the usual test folders.

## What a run leaves behind

`<project>/.souschef/runs/<run-id>/`: `brief.md` (what the agent was told), `task.json`,
`events.jsonl`, `state.json`, `agent.out.txt`, `agent.log`, and `result.json` (the agent's report):

```json
{
  "status": "failed",
  "tests_added": ["test/math.test.js"],
  "command": "npm test",
  "summary": { "total": 6, "passed": 5, "failed": 1, "skipped": 0 },
  "failures": [{ "test": "isEven returns true for 2", "message": "expected true, got false" }],
  "suspected_source_bugs": [{ "file": "src/math.js", "requirement": "isEven(2) is true", "detail": "uses n % 2 === 1" }],
  "uncovered_requirements": [],
  "notes": ""
}
```

`.souschef/` ignores itself, so the project's own `.gitignore` is left alone.

## Safety

The agent runs unattended, so it runs with `--dangerously-skip-permissions`. Three things keep it
in its lane:

1. The brief allows writes only inside `write_globs`, forbids touching production code and git
   state, and forbids killing processes.
2. After every run, souschef diffs `git status` against the snapshot taken at start. Anything
   changed outside `write_globs` comes back as `out_of_scope`, so you see it. Nothing is reverted
   automatically, since other people or sessions may share the working tree.
3. Only one run per project at a time. Processes are only ever killed by their own PID.

Use it on projects where an agent writing test files is acceptable, and review what it adds.

## Develop

```
npm install
npm run typecheck
npm run build      # bundles src/ into plugin/dist/server.cjs
npm run smoke      # real end-to-end run against agy on a throwaway project (takes a few minutes)
```

Adding a backend is one object in `src/adapters.ts`: how to find the binary, the headless
arguments, and how to read a conversation id for follow-ups.

## Roadmap

- More backends: `gemini -p`, `codex exec`.
- `isolation: "worktree"`: the agent works in its own git worktree; the result comes back as a patch.
- Detect the test process ("tests running") for richer progress.
- A small live view of a run on localhost.

## License

MIT
