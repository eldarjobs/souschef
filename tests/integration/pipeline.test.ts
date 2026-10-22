import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { watchTask } from '../../src/cli/watch.js';
import { createSousChef, eventsDir } from '../../src/mcp/server.js';
import { TaskStore } from '../../src/storage/task-store.js';

const FAKE_AGY = path.resolve('tests/fixtures/fake-agy.mjs');

function makeRepo(opts: { git?: boolean } = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'souschef-repo-'));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', type: 'module', scripts: { test: 'node --test' } }));
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src', 'math.js'), 'export const add = (a, b) => a + b;\n');
  writeFileSync(
    path.join(dir, '.souschef.json'),
    JSON.stringify({ agent: { executable: process.execPath, prefixArgs: [FAKE_AGY] }, maxRepairAttempts: 2 })
  );
  if (opts.git !== false) {
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, stdio: 'pipe' });
    git('init', '-q');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
  }
  // Uncommitted work: the agent must test this version, not HEAD.
  writeFileSync(path.join(dir, 'src', 'math.js'), 'export const add = (a, b) => a + b;\nexport const isEven = (n) => n % 2 === 0;\n');
  return dir;
}

function setup(mode: string, repo = makeRepo()) {
  const base = mkdtempSync(path.join(tmpdir(), 'souschef-run-'));
  const env = {
    ...process.env,
    SOUSCHEF_DATA_DIR: path.join(base, 'data'),
    SOUSCHEF_WORKSPACE_DIR: path.join(base, 'ws'),
    FAKE_AGY_MODE: mode,
    FAKE_AGY_MAIN_ROOT: repo
  };
  const app = createSousChef(env);
  return { repo, env, base, ...app };
}

async function runToEnd(mode: string, repo?: string) {
  const ctx = setup(mode, repo);
  const { taskId } = await ctx.manager.delegate({
    taskType: 'tests',
    objective: 'Test math helpers',
    projectRoot: ctx.repo,
    targetPaths: ['src/math.js']
  });
  const task = await ctx.manager.waitFor(taskId, 120_000);
  return { ...ctx, taskId, task: task! };
}

test('happy path: tests written, verified, applied; uncommitted work preserved', async () => {
  const { task, repo, store, taskId, environment } = await runToEnd('pass');
  assert.equal(task.status, 'COMPLETED', JSON.stringify(task.result ?? task.error));
  const r = task.result!;
  assert.equal(r.execution, 'PASSED');
  assert.equal(r.security.status, 'PASSED');
  assert.equal(r.apply.applied, true);
  assert.equal(r.tests.failed, 0);
  assert.equal(r.tests.passed, 2);
  assert.deepEqual(r.changedFiles, ['test/math.test.js']);
  assert.equal(r.agent.usage?.totalTokens, 125);
  assert.ok(existsSync(path.join(repo, 'test', 'math.test.js')));
  assert.match(readFileSync(path.join(repo, 'src', 'math.js'), 'utf8'), /isEven/, 'user change untouched');
  assert.match(store.getFiles(taskId)[0]!.diff, /\+test\('add'/);
  assert.deepEqual(readdirSync(environment.workspaceRoot).filter((n) => n.startsWith(taskId)), [], 'workspace cleaned up');
  const worktrees = execFileSync('git', ['worktree', 'list'], { cwd: repo, encoding: 'utf8' }).trim().split('\n');
  assert.equal(worktrees.length, 2, 'main checkout + the pooled worktree');
  assert.match(worktrees[1]!, /pool-[0-9a-f]{12}/);
  assert.deepEqual(readdirSync(environment.workspaceRoot).filter((n) => n.endsWith('.lock')), [], 'pool lock released');
});

test('pooled worktree is reused: build output kept, leftovers removed, unchanged files untouched', async () => {
  const first = await runToEnd('pass');
  const pool = path.join(first.environment.workspaceRoot, readdirSync(first.environment.workspaceRoot).find((n) => /^pool-[0-9a-f]+$/.test(n))!);
  mkdirSync(path.join(pool, 'bin'), { recursive: true });
  writeFileSync(path.join(pool, 'bin', 'build-cache.txt'), 'warm');
  writeFileSync(path.join(pool, 'leftover.txt'), 'from an earlier agent');
  const before = statSync(path.join(pool, 'package.json')).mtimeMs;

  const { taskId } = await first.manager.delegate({ taskType: 'tests', objective: 'Second pass', projectRoot: first.repo, targetPaths: ['src/math.js'] });
  const second = await first.manager.waitFor(taskId, 120_000);
  assert.equal(second!.workspacePath ?? pool, pool);
  assert.ok(existsSync(path.join(pool, 'bin', 'build-cache.txt')), 'ignored build output survives');
  assert.ok(!existsSync(path.join(pool, 'leftover.txt')), 'untracked leftovers are cleaned');
  assert.equal(statSync(path.join(pool, 'package.json')).mtimeMs, before, 'unchanged files are not rewritten');
  assert.equal(execFileSync('git', ['worktree', 'list'], { cwd: first.repo, encoding: 'utf8' }).trim().split('\n').length, 2);
});

test('live activity: agent steps are recorded and `watch` follows the task to its end', async () => {
  const { manager, taskId, environment } = await runToEnd('pass');
  const recent = manager.activity(taskId, 20).map((l) => l.slice(10));
  assert.ok(recent.includes('write  test/math.test.js'.replace('/', path.sep)), recent.join('\n'));
  assert.ok(recent.includes('agent: Tests written and run.'), recent.join('\n'));
  assert.ok(recent.some((l) => l.startsWith('[agent_writing]')));
  assert.match(recent.at(-1)!, /^== COMPLETED: /);

  const printed: string[] = [];
  const code = await watchTask(taskId, eventsDir(environment.dataDir), { pollMs: 10, write: (t) => void printed.push(t) });
  assert.equal(code, 0);
  const out = printed.join('');
  assert.match(out, /\[queued\] Waiting for a free slot/);
  assert.match(out, /-> exit 0 · ℹ pass 2/);
  assert.match(out, /== COMPLETED: /, 'watch stops at the done entry');

  const missing = await watchTask('task_missing', eventsDir(environment.dataDir), { pollMs: 10, waitForFileMs: 30, write: () => undefined });
  assert.equal(missing, 1);
});

test('business code change is detected and nothing is applied', async () => {
  const { task, repo } = await runToEnd('out-of-scope');
  assert.equal(task.status, 'NEEDS_REVIEW');
  assert.equal(task.result!.security.outOfScopeChanges, 1);
  assert.match(task.result!.security.violations![0]!, /src\/math\.js \(outside write_globs\)/);
  assert.equal(task.result!.apply.applied, false);
  assert.ok(!existsSync(path.join(repo, 'test', 'math.test.js')));
  assert.match(readFileSync(path.join(repo, 'src', 'math.js'), 'utf8'), /a \+ b/);
});

test('repair loop resumes the agent conversation until tests pass', async () => {
  const { task } = await runToEnd('repair');
  assert.equal(task.status, 'COMPLETED', JSON.stringify(task.result));
  assert.equal(task.result!.agent.attempts, 2);
});

test('tests still failing after the repair budget => FAILED, nothing applied', async () => {
  const { task, repo } = await runToEnd('always-fail');
  assert.equal(task.status, 'FAILED');
  assert.equal(task.result!.agent.attempts, 3);
  assert.equal(task.result!.tests.failed, 1);
  assert.ok(!existsSync(path.join(repo, 'test', 'math.test.js')));
});

test('suspected product bug stops repairs and asks for review', async () => {
  const { task } = await runToEnd('product-bug');
  assert.equal(task.status, 'NEEDS_REVIEW');
  assert.equal(task.result!.agent.suspectedProductBug, true);
  assert.equal(task.result!.agent.attempts, 1);
});

test('agent crash and empty runs are reported separately from test failures', async () => {
  const crash = await runToEnd('crash');
  assert.equal(crash.task.status, 'FAILED');
  assert.equal(crash.task.result!.execution, 'FAILED');
  const none = await runToEnd('no-change');
  assert.equal(none.task.status, 'FAILED');
  assert.match(none.task.error ?? '', /without changing any file/);
});

test('conflict with the live checkout => NEEDS_REVIEW, user file kept', async () => {
  const { task, repo } = await runToEnd('conflict');
  assert.equal(task.status, 'NEEDS_REVIEW');
  assert.deepEqual(task.result!.apply.conflicts, ['test/math.test.js']);
  assert.equal(readFileSync(path.join(repo, 'test', 'math.test.js'), 'utf8'), '// user edit\n');
});

test('cancel stops the agent process', async () => {
  const ctx = setup('sleep');
  const { taskId } = await ctx.manager.delegate({ taskType: 'tests', objective: 'x', projectRoot: ctx.repo, targetPaths: ['src/math.js'] });
  for (let i = 0; i < 100 && ctx.manager.get(taskId)?.phase !== 'agent_writing'; i++) await new Promise((r) => setTimeout(r, 100));
  const started = Date.now();
  const res = ctx.manager.cancel(taskId);
  assert.equal(res.killedProcesses, 1);
  const task = await ctx.manager.waitFor(taskId, 30_000);
  assert.equal(task!.status, 'CANCELLED');
  assert.ok(Date.now() - started < 20_000);
});

test('explicit idempotency key returns the same task', async () => {
  const ctx = setup('pass');
  const a = await ctx.manager.delegate({ taskType: 'tests', objective: 'x', projectRoot: ctx.repo, targetPaths: [], idempotencyKey: 'k1' });
  const b = await ctx.manager.delegate({ taskType: 'tests', objective: 'x', projectRoot: ctx.repo, targetPaths: [], idempotencyKey: 'k1' });
  assert.equal(a.taskId, b.taskId);
  assert.equal(b.deduplicated, true);
  await ctx.manager.waitFor(a.taskId, 120_000);
});

test('non-git projects run in a copied workspace', async () => {
  const { task, repo } = await runToEnd('pass', makeRepo({ git: false }));
  assert.equal(task.status, 'COMPLETED', JSON.stringify(task.result ?? task.error));
  assert.ok(existsSync(path.join(repo, 'test', 'math.test.js')));
});

test('results survive a restart; in-flight tasks are marked failed', async () => {
  const { taskId, env, store } = await runToEnd('pass');
  store.close();
  const raw = new TaskStore(path.join(env.SOUSCHEF_DATA_DIR!, 'souschef.db'));
  const now = new Date().toISOString();
  raw.insert({
    id: 'stale',
    status: 'CREATED',
    phase: 'pending',
    taskType: 'tests',
    input: { taskType: 'tests', objective: 'x', projectRoot: '.', targetPaths: [] },
    idempotencyKey: 'stale',
    progress: '',
    createdAt: now,
    updatedAt: now
  });
  raw.update('stale', { status: 'RUNNING' });
  raw.close();
  const again = createSousChef(env);
  assert.equal(again.manager.get(taskId)?.status, 'COMPLETED');
  assert.equal(again.manager.get(taskId)?.result?.apply.applied, true);
  assert.equal(again.manager.get('stale')?.status, 'FAILED');
});
