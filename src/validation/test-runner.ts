import path from 'node:path';
import type { ProcessRunner } from '../core/process-runner.js';
import type { CommandPolicy } from '../security/command-policy.js';
import { isInside } from '../security/path-policy.js';
import type { CommandOutcome, CommandSpec, TestCounts } from '../types.js';

export interface TestRunOutcome extends CommandOutcome {
  counts: TestCounts;
  command: string;
}

export interface TestRunnerDeps {
  runner: ProcessRunner;
  policy: CommandPolicy;
}

/** Runs build/test commands inside the workspace. No shell, allow-listed executables only. */
export class TestRunner {
  constructor(private readonly deps: TestRunnerDeps) {}

  async run(
    spec: CommandSpec,
    workspaceRoot: string,
    opts: { timeoutMs: number; maxOutputBytes: number; taskId: string; env?: NodeJS.ProcessEnv }
  ): Promise<TestRunOutcome> {
    const cwd = path.resolve(workspaceRoot, spec.cwd);
    if (!isInside(workspaceRoot, cwd)) throw new Error(`Command cwd "${spec.cwd}" escapes the workspace`);
    // Relative executables (e.g. .venv/Scripts/python.exe) resolve against the command cwd.
    const executable =
      /[\\/]/.test(spec.executable) && !path.isAbsolute(spec.executable) ? path.resolve(cwd, spec.executable) : spec.executable;
    if (path.isAbsolute(executable) && /[\\/]/.test(spec.executable) && !path.isAbsolute(spec.executable) && !isInside(workspaceRoot, executable)) {
      throw new Error(`Executable "${spec.executable}" escapes the workspace`);
    }
    const resolved = this.deps.policy.resolve({ ...spec, executable });
    const env: NodeJS.ProcessEnv = { ...(opts.env ?? process.env), CI: 'true', DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', NO_COLOR: '1', FORCE_COLOR: '0' };
    // Inherited from a parent `node --test` run, this turns the project's own node:test run
    // into a silent subtest that always exits 0.
    delete env.NODE_TEST_CONTEXT;
    const outcome = await this.deps.runner.run(resolved, {
      cwd,
      timeoutMs: opts.timeoutMs,
      maxOutputBytes: opts.maxOutputBytes,
      taskId: opts.taskId,
      env
    });
    return { ...outcome, counts: parseTestCounts(outcome.output), command: formatCommand(spec) };
  }
}

export function formatCommand(spec: CommandSpec): string {
  return [spec.executable, ...spec.args].join(' ');
}

const ANSI = /\x1b\[[0-9;]*m/g;

/** Best-effort counts from common runners. Exit code stays the source of truth. */
export function parseTestCounts(raw: string): TestCounts {
  const out = raw.replace(ANSI, '');
  const num = (re: RegExp) => {
    let total: number | undefined;
    for (const m of out.matchAll(re)) total = (total ?? 0) + Number(m[1]);
    return total;
  };

  // dotnet: "Passed!  - Failed:     0, Passed:    12, Skipped:     0, Total: 12"
  if (/(Passed|Failed)!\s+-\s+Failed:/.test(out)) {
    return {
      failed: num(/!\s+-\s+Failed:\s+(\d+),/g),
      passed: num(/,\s+Passed:\s+(\d+),/g),
      skipped: num(/,\s+Skipped:\s+(\d+),/g)
    };
  }
  // dotnet (newer summary): "Test summary: total: 12, failed: 0, succeeded: 12, skipped: 0"
  const dn = out.match(/Test summary:\s*total:\s*\d+,\s*failed:\s*(\d+),\s*succeeded:\s*(\d+),\s*skipped:\s*(\d+)/i);
  if (dn) return { failed: Number(dn[1]), passed: Number(dn[2]), skipped: Number(dn[3]) };

  // cargo: "test result: ok. 12 passed; 0 failed; 0 ignored"
  if (/test result: (ok|FAILED)\./.test(out)) {
    return { passed: num(/test result: \w+\. (\d+) passed/g), failed: num(/(\d+) failed;/g), skipped: num(/(\d+) ignored;/g) };
  }
  // jest / vitest: "Tests:       1 failed, 12 passed, 13 total" / "Tests  12 passed (12)"
  const jest = out.match(/^\s*Tests:?\s+(.+)$/m);
  if (jest && /(passed|failed)/.test(jest[1]!)) {
    const line = jest[1]!;
    const get = (word: string) => {
      const m = line.match(new RegExp(`(\\d+) ${word}`));
      return m ? Number(m[1]) : 0;
    };
    return { passed: get('passed'), failed: get('failed'), skipped: get('skipped') + get('todo') };
  }
  // node:test TAP summary: "# pass 12" / "# fail 0"  or spec reporter "ℹ pass 12"
  const nodePass = out.match(/^(?:#|ℹ)\s*pass\s+(\d+)/m);
  if (nodePass) {
    const fail = out.match(/^(?:#|ℹ)\s*fail\s+(\d+)/m);
    const skip = out.match(/^(?:#|ℹ)\s*skipped\s+(\d+)/m);
    return { passed: Number(nodePass[1]), failed: fail ? Number(fail[1]) : 0, skipped: skip ? Number(skip[1]) : 0 };
  }
  // pytest: "=== 2 failed, 12 passed, 1 skipped in 0.12s ===" / "12 passed in 0.10s"
  const py = out.match(/(?:^|=+\s*)((?:\d+ \w+(?:, )?)+) in [\d.]+s/m);
  if (py) {
    const line = py[1]!;
    const get = (word: string) => {
      const m = line.match(new RegExp(`(\\d+) ${word}`));
      return m ? Number(m[1]) : 0;
    };
    return { passed: get('passed'), failed: get('failed') + get('error') + get('errors'), skipped: get('skipped') };
  }
  // go test -v: count PASS/FAIL markers
  const goPass = (out.match(/^\s*--- PASS:/gm) ?? []).length;
  const goFail = (out.match(/^\s*--- FAIL:/gm) ?? []).length;
  if (goPass + goFail > 0) return { passed: goPass, failed: goFail };
  return {};
}
