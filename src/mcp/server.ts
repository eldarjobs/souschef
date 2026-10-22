import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { AgyAdapter } from '../adapters/agy/agy.adapter.js';
import { loadConfig, loadEnvironment } from '../config/config-loader.js';
import { ProcessRegistry, ProcessRunner } from '../core/process-runner.js';
import { TaskManager } from '../core/task-manager.js';
import { discoverTestPlan } from '../discovery/project-discovery.js';
import { statusView } from '../reporting/summary-builder.js';
import { captureBaseline } from '../security/git-baseline.js';
import { Redactor } from '../security/redact.js';
import { TaskStore } from '../storage/task-store.js';
import { PLANNED_TASK_TYPES, TASK_TYPES, type TaskType } from '../types.js';
import { WorkspaceManager } from '../workspace/workspace-manager.js';

const VERSION = '0.2.0';

export function createSousChef(env: NodeJS.ProcessEnv = process.env) {
  const environment = loadEnvironment(env);
  const store = new TaskStore(path.join(environment.dataDir, 'souschef.db'));
  const registry = new ProcessRegistry();
  const runner = new ProcessRunner(registry, new Redactor(env));
  const workspaces = new WorkspaceManager();
  const manager = new TaskManager({
    store,
    registry,
    workspaceRoot: environment.workspaceRoot,
    maxConcurrentTasks: environment.maxConcurrentTasks,
    pipeline: { runner, workspaces, createAdapter: (config) => new AgyAdapter(runner, config.agent, env) }
  });
  manager.recover();
  return { environment, store, registry, runner, manager };
}

const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
const fail = (message: string) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true });

export function createServer(env: NodeJS.ProcessEnv = process.env): { server: McpServer; manager: TaskManager; store: TaskStore } {
  const { manager, store, runner } = createSousChef(env);
  const defaultRoot = env.SOUSCHEF_PROJECT_ROOT ?? env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const server = new McpServer({ name: 'souschef', version: VERSION });

  server.registerTool(
    'delegate_task',
    {
      title: 'Delegate a task to the tester agent',
      description:
        'Starts a task (currently taskType "tests") in an isolated workspace and returns a taskId immediately. ' +
        'SousChef detects the test command, lets the agent write tests, runs build/tests, checks that only test files changed, ' +
        'and applies verified test files to the checkout. Follow with wait_for_task, then get_task_result.',
      inputSchema: z.object({
        taskType: z.enum([...TASK_TYPES, ...PLANNED_TASK_TYPES]).describe('Only "tests" runs today.'),
        objective: z.string().min(1).max(4000).describe('What to test and why, with concrete expected behaviour.'),
        targetPaths: z.array(z.string()).max(100).default([]).describe('Production files under test, relative to projectRoot.'),
        projectRoot: z.string().optional().describe('Absolute project root. Defaults to the server working directory.'),
        module: z.string().optional().describe('Module root (relative) in a monorepo.'),
        maxRepairAttempts: z.number().int().min(0).max(5).optional(),
        timeoutMinutes: z.number().positive().max(240).optional(),
        idempotencyKey: z.string().max(200).optional().describe('Same key returns the same task instead of starting a new one.'),
        continueFrom: z.string().optional().describe('taskId of a finished task: continue its agent conversation with this objective as feedback.')
      })
    },
    async (args) => {
      if (!TASK_TYPES.includes(args.taskType as TaskType)) {
        return fail(`taskType "${args.taskType}" is planned but not supported yet. Supported: ${TASK_TYPES.join(', ')}.`);
      }
      try {
        const res = await manager.delegate({
          taskType: args.taskType as TaskType,
          objective: args.objective,
          targetPaths: args.targetPaths,
          projectRoot: args.projectRoot ?? defaultRoot,
          module: args.module,
          maxRepairAttempts: args.maxRepairAttempts,
          timeoutMinutes: args.timeoutMinutes,
          idempotencyKey: args.idempotencyKey,
          continueFrom: args.continueFrom
        });
        return json(res);
      } catch (err) {
        return fail((err as Error).message);
      }
    }
  );

  server.registerTool(
    'get_task_status',
    {
      title: 'Task status',
      description: 'Current status, phase and one-line progress of a task.',
      inputSchema: z.object({ taskId: z.string() }),
      annotations: { readOnlyHint: true }
    },
    async ({ taskId }) => {
      const task = manager.get(taskId);
      return task ? json(statusView(task)) : fail(`Unknown task ${taskId}`);
    }
  );

  server.registerTool(
    'wait_for_task',
    {
      title: 'Wait for a task',
      description: 'Blocks until the task finishes or timeoutSeconds passes, then returns its status. Call again while it is still running.',
      inputSchema: z.object({ taskId: z.string(), timeoutSeconds: z.number().int().min(1).max(600).default(50) }),
      annotations: { readOnlyHint: true }
    },
    async ({ taskId, timeoutSeconds }) => {
      const task = await manager.waitFor(taskId, timeoutSeconds * 1000);
      if (!task) return fail(`Unknown task ${taskId}`);
      return json({ ...statusView(task), finished: ['COMPLETED', 'NEEDS_REVIEW', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(task.status) });
    }
  );

  server.registerTool(
    'get_task_result',
    {
      title: 'Task result',
      description:
        'Compact JSON report (status, build, test counts, security check, applied files, summary). ' +
        'Logs are included only when asked for via include.',
      inputSchema: z.object({
        taskId: z.string(),
        include: z.array(z.enum(['testOutput', 'buildOutput', 'agentResponse'])).default([]),
        maxChars: z.number().int().min(200).max(100_000).default(8000).describe('Per included log; the tail is kept.')
      }),
      annotations: { readOnlyHint: true }
    },
    async ({ taskId, include, maxChars }) => {
      const task = manager.get(taskId);
      if (!task) return fail(`Unknown task ${taskId}`);
      const base = task.result ?? { taskId, status: task.status, summary: task.progress, ...(task.error ? { reason: task.error } : {}) };
      if (include.length === 0) return json(base);
      const logs = store.getLogs(taskId);
      const extra: Record<string, string> = {};
      for (const key of include) {
        const text = logs[key];
        if (text) extra[key] = text.length > maxChars ? `...[${text.length - maxChars} chars omitted]\n${text.slice(-maxChars)}` : text;
      }
      return json({ ...base, logs: extra });
    }
  );

  server.registerTool(
    'get_task_diff',
    {
      title: 'Task diff',
      description:
        'Unified diff of the files the task changed (including out-of-scope ones). Large diffs return a file list first; ' +
        'then request one path at a time and page with offset.',
      inputSchema: z.object({
        taskId: z.string(),
        path: z.string().optional(),
        offset: z.number().int().min(0).default(0),
        maxChars: z.number().int().min(500).max(200_000).default(20_000)
      }),
      annotations: { readOnlyHint: true }
    },
    async ({ taskId, path: file, offset, maxChars }) => {
      const task = manager.get(taskId);
      if (!task) return fail(`Unknown task ${taskId}`);
      const files = store.getFiles(taskId);
      const listing = files.map((f) => ({ path: f.path, change: f.change, allowed: f.allowed, chars: f.diff.length }));
      if (file) {
        const f = files.find((x) => x.path === file.replace(/\\/g, '/'));
        if (!f) return fail(`No diff for ${file}. Files: ${files.map((x) => x.path).join(', ')}`);
        const chunk = f.diff.slice(offset, offset + maxChars);
        const next = offset + chunk.length < f.diff.length ? offset + chunk.length : undefined;
        return json({ path: f.path, change: f.change, allowed: f.allowed, offset, ...(next !== undefined ? { nextOffset: next } : {}), diff: chunk });
      }
      const total = files.reduce((n, f) => n + f.diff.length, 0);
      if (total <= maxChars) return json({ files: listing, diff: files.map((f) => f.diff).join('') });
      return json({ files: listing, totalChars: total, note: 'Diff too large; call again with "path" for one file.' });
    }
  );

  server.registerTool(
    'cancel_task',
    {
      title: 'Cancel a task',
      description: 'Stops a queued or running task and the processes SousChef started for it. Nothing is applied.',
      inputSchema: z.object({ taskId: z.string() }),
      annotations: { destructiveHint: false }
    },
    async ({ taskId }) => {
      try {
        const res = manager.cancel(taskId);
        const settled = await manager.waitFor(taskId, 15_000);
        return json({ ...res, status: settled?.status ?? res.status });
      } catch (err) {
        return fail((err as Error).message);
      }
    }
  );

  server.registerTool(
    'doctor',
    {
      title: 'Check setup',
      description: 'Checks the agent binary, the project config and the detected test command. ping=true also sends the agent a one-word prompt.',
      inputSchema: z.object({ projectRoot: z.string().optional(), ping: z.boolean().default(false) }),
      annotations: { readOnlyHint: true }
    },
    async ({ projectRoot, ping }) => {
      const root = path.resolve(projectRoot ?? defaultRoot);
      const report: Record<string, unknown> = { version: VERSION, projectRoot: root, node: process.version };
      let config;
      try {
        config = loadConfig(root);
        report.config = 'ok';
      } catch (err) {
        report.config = (err as Error).message;
        return json(report);
      }
      const adapter = new AgyAdapter(runner, config.agent, env);
      report.agent = await adapter.checkAvailable();
      const base = await captureBaseline(root);
      report.git = base.isRepo ? { repo: true, head: base.head?.slice(0, 12) ?? null, dirty: base.dirty } : { repo: false, mode: 'copy' };
      const discovery = discoverTestPlan(root, config, []);
      report.tests = discovery.plan
        ? { command: [discovery.plan.test.executable, ...discovery.plan.test.args].join(' '), cwd: discovery.plan.test.cwd, source: discovery.plan.source }
        : { problem: discovery.problem };
      if (ping && (report.agent as { ok: boolean }).ok) {
        const res = await adapter.run({
          taskId: `doctor_${Date.now()}`,
          cwd: root,
          prompt: 'Reply with the single word PONG. Do not use any tools.',
          scratchDir: path.join(loadEnvironment(env).workspaceRoot, 'doctor'),
          timeoutMs: 120_000,
          maxOutputBytes: 20_000
        });
        report.ping = { ok: res.ok && /PONG/i.test(res.response ?? ''), status: res.status, seconds: Math.round(res.durationMs / 1000) };
      }
      return json(report);
    }
  );

  return { server, manager, store };
}

async function main() {
  const { server } = createServer();
  await server.connect(new StdioServerTransport());
}

// Started directly (node server.cjs / npx souschef), not imported by tests.
const entry = process.argv[1] ? path.basename(process.argv[1]) : '';
if (/^(server\.(c?js|ts)|souschef)$/.test(entry)) {
  main().catch((err) => {
    process.stderr.write(`souschef: ${(err as Error).stack ?? err}\n`);
    process.exit(1);
  });
}
