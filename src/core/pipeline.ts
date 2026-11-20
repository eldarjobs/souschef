import path from 'node:path';
import { addUsage, type AgentAdapter, type AgentEvent, type AgentRunResult } from '../adapters/agent-adapter.js';
import { loadConfig, type SousChefConfig } from '../config/config-loader.js';
import { discoverTestPlan } from '../discovery/project-discovery.js';
import { buildSummaryLine } from '../reporting/summary-builder.js';
import { CommandPolicy } from '../security/command-policy.js';
import { PathPolicy } from '../security/path-policy.js';
import type { StoredFileDiff, StoredLogs } from '../storage/task-store.js';
import type { AgentUsage, CheckStatus, CommandSpec, CompactResult, TaskPhase, TaskRecord, TaskStatus, TestPlan } from '../types.js';
import { applyFiles, checkScope, findConflicts, type ScopeReport } from '../validation/result-validator.js';
import { narrowDotnetTest } from '../validation/targeted-tests.js';
import { formatCommand, TestRunner, type TestRunOutcome } from '../validation/test-runner.js';
import type { Workspace, WorkspaceManager } from '../workspace/workspace-manager.js';
import {
  AGENT_OUTPUT_SCHEMA,
  buildInitialPrompt,
  buildRepairPrompt,
  readAgentReport,
  tailForRepair,
  type AgentReport,
  type PromptContext
} from './context-engine.js';
import type { ProcessRunner } from './process-runner.js';

/** What the task manager gives one pipeline run. */
export interface PipelineContext {
  task: TaskRecord;
  workspaceRoot: string;
  scratchDir: string;
  /** Agent conversation to resume (follow-up tasks). */
  resumeSessionId?: string;
  setStatus(status: TaskStatus): void;
  setPhase(phase: TaskPhase, progress: string): void;
  /** A step the agent just took, for the live activity view. */
  recordEvent?(event: AgentEvent): void;
  setPid(pid: number | null): void;
  setWorkspace(p: string | null): void;
  saveFiles(files: StoredFileDiff[]): void;
  saveLogs(logs: StoredLogs): void;
  /** Compare-and-set: true only for the first caller. */
  claimApply(): boolean;
  releaseApply(): void;
  isCancelled(): boolean;
  isTimedOut(): boolean;
}

export interface PipelineDeps {
  runner: ProcessRunner;
  workspaces: WorkspaceManager;
  createAdapter(config: SousChefConfig): AgentAdapter;
}

export interface PipelineOutcome {
  status: TaskStatus;
  result: CompactResult;
  error?: string;
}

interface RunState {
  execution: CheckStatus;
  build: CheckStatus;
  attempts: number;
  usage?: AgentUsage;
  report?: AgentReport;
  testsCreated: number;
  lastTest?: TestRunOutcome;
  testScope?: 'changed' | 'full';
  lastBuild?: TestRunOutcome;
  scope?: ScopeReport;
  applied: boolean;
  applyReason?: string;
  conflicts?: string[];
  agentName: string;
  sessionId?: string;
}

/**
 * One delegated test task, end to end:
 * discover -> isolate -> agent writes -> build/test -> repair loop -> scope check -> apply.
 * The agent finishing is never treated as success on its own.
 */
export async function runTestsPipeline(ctx: PipelineContext, deps: PipelineDeps): Promise<PipelineOutcome> {
  const { task } = ctx;
  const input = task.input;
  const state: RunState = { execution: 'NOT_RUN', build: 'NOT_RUN', attempts: 0, testsCreated: 0, applied: false, agentName: 'unknown' };
  const done = (status: TaskStatus, error?: string): PipelineOutcome => {
    const result = compact(task.id, status, state);
    return { status, result: error ? { ...result, reason: error.slice(0, 500) } : result, error };
  };

  ctx.setStatus('RUNNING');
  ctx.setPhase('discovering', 'Reading configuration and detecting test infrastructure');
  let config: SousChefConfig;
  try {
    config = loadConfig(input.projectRoot);
  } catch (err) {
    return done('FAILED', (err as Error).message);
  }
  const discovery = discoverTestPlan(input.projectRoot, config, input.targetPaths, input.module);
  if (!discovery.plan) return done('FAILED', discovery.problem ?? 'No test plan');
  const plan = discovery.plan;

  const adapter = deps.createAdapter(config);
  state.agentName = adapter.name;
  const available = await adapter.checkAvailable();
  if (!available.ok) return done('FAILED', available.detail);

  const policy = new CommandPolicy(config.allowedExecutables);
  for (const spec of [plan.build, plan.test]) {
    if (spec && !policy.isAllowed(spec.executable) && !/[\\/]/.test(spec.executable)) {
      return done('FAILED', `Executable "${spec.executable}" is not allowed; add it to allowedExecutables in .souschef.json.`);
    }
  }
  const testRunner = new TestRunner({ runner: deps.runner, policy });

  if (ctx.isCancelled()) return done('CANCELLED');
  ctx.setPhase('preparing_workspace', 'Creating isolated workspace with uncommitted changes');
  let ws: Workspace;
  try {
    ws = await deps.workspaces.prepare({
      taskId: task.id,
      projectRoot: input.projectRoot,
      workspaceRoot: ctx.workspaceRoot,
      linkDirs: config.linkDirs,
      copyExclude: config.copyExclude,
      reuse: config.reuseWorkspace
    });
  } catch (err) {
    return done('FAILED', `Workspace preparation failed: ${(err as Error).message}`);
  }
  ctx.setWorkspace(ws.root);

  try {
    return await runInWorkspace();
  } finally {
    ctx.setPhase('cleanup', 'Removing workspace');
    ctx.setPid(null);
    if (!config.keepWorkspace) {
      await deps.workspaces.cleanup(ws).catch(() => undefined);
      ctx.setWorkspace(null);
    }
  }

  async function runInWorkspace(): Promise<PipelineOutcome> {
    const sub = ws.projectSubdir;
    const prefixGlob = (g: string) => (!sub || g.startsWith('**/') ? g : `${sub}/${g}`);
    const moduleGlobs = config.modules.find((m) => m.root === plan.moduleRoot)?.writeGlobs;
    const writeGlobs = (moduleGlobs ?? config.writeGlobs).map(prefixGlob);
    const pathPolicy = new PathPolicy({
      writeGlobs,
      protectedGlobs: config.protectedGlobs.map(prefixGlob),
      allowSymlinks: config.allowSymlinks
    });
    const inWs = (spec: CommandSpec): CommandSpec => ({ ...spec, cwd: path.posix.join(sub || '.', spec.cwd) });
    const promptCtx: PromptContext = {
      objective: input.objective,
      targetPaths: input.targetPaths,
      uncommittedChanges: [...changedPathsFromDiff(ws.baseline.trackedDiff ?? ''), ...ws.baseline.untracked],
      plan,
      writeGlobs,
      projectSubdir: sub,
      rules: config.rules
    };
    const maxRepairs = input.maxRepairAttempts ?? config.maxRepairAttempts;
    const agentTimeoutMs = config.agent.timeoutMinutes * 60_000;
    const commandTimeoutMs = config.commandTimeoutMinutes * 60_000;
    const logs: StoredLogs = {};

    const runAgent = async (prompt: string, phase: TaskPhase, progress: string): Promise<AgentRunResult> => {
      ctx.setPhase(phase, progress);
      state.attempts++;
      const res = await adapter.run({
        taskId: task.id,
        cwd: ws.root,
        prompt,
        resumeSessionId: state.sessionId ?? ctx.resumeSessionId,
        outputSchema: AGENT_OUTPUT_SCHEMA,
        scratchDir: ctx.scratchDir,
        timeoutMs: agentTimeoutMs,
        maxOutputBytes: config.maxOutputBytes,
        onSpawn: (pid) => ctx.setPid(pid),
        onEvent: (event) => ctx.recordEvent?.(event)
      });
      ctx.setPid(null);
      state.usage = addUsage(state.usage, res.usage);
      state.sessionId = res.sessionId ?? state.sessionId;
      logs.agentSessionId = state.sessionId;
      logs.agentResponse = res.response ?? res.rawOutput.slice(-20_000);
      const report = readAgentReport(res.structured);
      if (report) {
        state.report = report;
        state.testsCreated += report.testsCreated;
      }
      ctx.saveLogs(logs);
      return res;
    };

    const interrupted = (): PipelineOutcome | undefined => {
      if (ctx.isTimedOut()) return done('TIMED_OUT', 'Task time limit reached');
      if (ctx.isCancelled()) return done('CANCELLED');
      return undefined;
    };

    const recordChanges = async () => {
      const changes = await deps.workspaces.changes(ws);
      state.scope = checkScope(ws, changes, pathPolicy, config.allowDeletions);
      const files: StoredFileDiff[] = [];
      for (const f of state.scope.files) {
        files.push({ path: f.path, change: f.change, allowed: f.allowed, diff: await deps.workspaces.fileDiff(ws, f.path) });
      }
      ctx.saveFiles(files);
      return state.scope;
    };

    // First agent turn.
    const firstPrompt = ctx.resumeSessionId
      ? [
          'Follow-up on your previous test task. This is a fresh copy of the repository: tests from the',
          'previous run are present only if they were accepted. Recreate or adjust them as needed.',
          '',
          input.objective,
          '',
          buildInitialPrompt(promptCtx)
        ].join('\n')
      : buildInitialPrompt(promptCtx);
    let agentRes = await runAgent(firstPrompt, 'agent_writing', `${adapter.name} is writing tests`);

    for (;;) {
      const stop = interrupted();
      if (stop) return stop;
      if (!agentRes.ok) {
        state.execution = 'FAILED';
        if (agentRes.timedOut) return done('TIMED_OUT', `Agent exceeded ${config.agent.timeoutMinutes} minutes`);
        return done('FAILED', agentRes.error ?? `Agent exited with ${agentRes.exitCode}`);
      }
      state.execution = 'PASSED';

      ctx.setStatus('VALIDATING');
      ctx.setPhase('checking_scope', 'Checking which files the agent changed');
      const scope = await recordChanges();
      if (scope.violations.length > 0) return done('NEEDS_REVIEW', 'Agent changed files outside the allowed test paths');
      if (scope.files.length === 0) return done('FAILED', 'Agent finished without changing any file');

      let failureOutput: string | undefined;
      const testCwd = path.posix.join(sub || '.', plan.test.cwd);
      const changedFiles = scope.files.filter((f) => f.change !== 'D').map((f) => f.path);
      // `dotnet test <project>` builds just that project and its references, so the separate
      // solution-wide build step is skipped too.
      const narrowed = config.testScope === 'changed' ? narrowDotnetTest(plan.test, changedFiles, ws.root, testCwd) : undefined;
      if (narrowed) {
        state.build = 'SKIPPED';
        state.testScope = 'changed';
      } else if (plan.build) {
        ctx.setPhase('building', `Running ${formatCommand(plan.build)}`);
        state.lastBuild = await testRunner.run(inWs(plan.build), ws.root, {
          timeoutMs: commandTimeoutMs,
          maxOutputBytes: config.maxOutputBytes,
          taskId: task.id
        });
        logs.buildOutput = state.lastBuild.output;
        state.build = state.lastBuild.exitCode === 0 && !state.lastBuild.timedOut ? 'PASSED' : 'FAILED';
        if (state.build === 'FAILED') failureOutput = state.lastBuild.output;
      } else {
        state.build = 'SKIPPED';
      }
      const stopAfterBuild = interrupted();
      if (stopAfterBuild) return stopAfterBuild;

      if (!failureOutput) {
        const runs = (narrowed ?? [plan.test]).map(inWs);
        const outcomes: TestRunOutcome[] = [];
        for (const spec of runs) {
          ctx.setPhase('testing', `Running ${formatCommand(spec)}`);
          outcomes.push(
            await testRunner.run(spec, ws.root, {
              timeoutMs: commandTimeoutMs,
              maxOutputBytes: config.maxOutputBytes,
              taskId: task.id
            })
          );
          if (interrupted()) break;
        }
        state.lastTest = mergeOutcomes(outcomes);
        logs.testOutput = state.lastTest.output;
        if (state.lastTest.exitCode !== 0 || state.lastTest.timedOut) failureOutput = state.lastTest.output;
      }
      ctx.saveLogs(logs);
      const stopAfterTests = interrupted();
      if (stopAfterTests) return stopAfterTests;

      if (!failureOutput) break;
      if (state.report?.suspectedProductBug) return done('NEEDS_REVIEW', state.report.productBugDetails || 'Agent suspects a bug in the code under test');
      if (state.attempts > maxRepairs) {
        return done('FAILED', state.build === 'FAILED' ? 'Build still failing after repair attempts' : 'Tests still failing after repair attempts');
      }
      ctx.setStatus('RUNNING');
      const repair = state.attempts; // attempts so far == repair number about to run
      agentRes = await runAgent(
        buildRepairPrompt(promptCtx, tailForRepair(failureOutput), repair, maxRepairs),
        'agent_repairing',
        `Repair attempt ${repair} of ${maxRepairs}`
      );
    }

    // Test runs can create files too; the final check covers everything that would be applied.
    ctx.setPhase('checking_scope', 'Final scope check');
    const finalScope = await recordChanges();
    if (finalScope.violations.length > 0) return done('NEEDS_REVIEW', 'Files outside the allowed test paths changed during the run');

    if (!config.autoApply) {
      state.applyReason = 'autoApply is disabled; read the patch with get_task_diff';
      return done('COMPLETED');
    }
    ctx.setPhase('applying', 'Checking the checkout for conflicts');
    state.conflicts = await findConflicts(ws, deps.workspaces, finalScope.files, pathPolicy);
    if (state.conflicts.length > 0) {
      state.applyReason = 'files changed in the checkout while the task ran';
      return done('NEEDS_REVIEW', 'Conflicts with the current checkout');
    }
    if (!ctx.claimApply()) {
      state.applyReason = 'already applied';
      return done('COMPLETED');
    }
    try {
      applyFiles(ws, deps.workspaces, finalScope.files);
      state.applied = true;
    } catch (err) {
      ctx.releaseApply();
      state.applyReason = `apply failed: ${(err as Error).message}`;
      return done('NEEDS_REVIEW', state.applyReason);
    }
    return done('COMPLETED');
  }
}

function compact(taskId: string, status: TaskStatus, s: RunState): CompactResult {
  const scope = s.scope;
  const violations = scope?.violations ?? [];
  const base: Omit<CompactResult, 'summary'> = {
    taskId,
    status,
    execution: s.execution,
    build: s.build,
    tests: {
      ...(s.lastTest ? { command: s.lastTest.command, scope: s.testScope ?? 'full' } : {}),
      created: s.testsCreated || undefined,
      passed: s.lastTest?.counts.passed,
      failed: s.lastTest?.counts.failed,
      exitCode: s.lastTest?.exitCode
    },
    security: {
      status: scope ? (violations.length === 0 ? 'PASSED' : 'FAILED') : 'NOT_RUN',
      outOfScopeChanges: violations.length,
      ...(violations.length > 0 ? { violations: violations.slice(0, 20).map((v) => `${v.path} (${v.reason})`) } : {})
    },
    apply: {
      applied: s.applied,
      ...(s.applyReason ? { reason: s.applyReason } : {}),
      ...(s.conflicts?.length ? { conflicts: s.conflicts.slice(0, 20) } : {})
    },
    changedFiles: (scope?.files ?? []).filter((f) => f.allowed).map((f) => f.path).slice(0, 50),
    ...(scope?.modifiedExisting.length ? { modifiedExistingTests: scope.modifiedExisting.slice(0, 20) } : {}),
    agent: {
      name: s.agentName,
      attempts: s.attempts,
      ...(s.usage ? { usage: s.usage } : {}),
      ...(s.report?.suspectedProductBug ? { suspectedProductBug: true } : {})
    }
  };
  return { ...base, summary: buildSummaryLine(base) };
}

function changedPathsFromDiff(diff: string): string[] {
  const out = new Set<string>();
  for (const m of diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) out.add(m[2]!);
  return [...out];
}

export type { TestPlan };

/** Several targeted runs reported as one: first failure wins, counts add up. */
function mergeOutcomes(outcomes: TestRunOutcome[]): TestRunOutcome {
  if (outcomes.length === 1) return outcomes[0]!;
  const sum = (k: 'passed' | 'failed' | 'skipped') =>
    outcomes.some((o) => o.counts[k] !== undefined) ? outcomes.reduce((n, o) => n + (o.counts[k] ?? 0), 0) : undefined;
  const failed = outcomes.find((o) => o.exitCode !== 0 || o.timedOut);
  return {
    ...(failed ?? outcomes[outcomes.length - 1]!),
    command: outcomes.map((o) => o.command).join(' ; '),
    output: outcomes.map((o) => o.output).join('\n'),
    truncated: outcomes.some((o) => o.truncated),
    durationMs: outcomes.reduce((n, o) => n + o.durationMs, 0),
    counts: { passed: sum('passed'), failed: sum('failed'), skipped: sum('skipped') }
  };
}
