import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AgentEvent } from '../../src/adapters/agent-adapter.js';
import { AgyStreamParser, commandSummary, parseAgyJson, toolAction } from '../../src/adapters/agy/agy.adapter.js';
import { configSchema, loadConfig, splitCommandLine } from '../../src/config/config-loader.js';
import { canTransition, isTerminal } from '../../src/core/state-machine.js';
import { discoverTestPlan } from '../../src/discovery/project-discovery.js';
import { CommandPolicy } from '../../src/security/command-policy.js';
import { parseNameStatusZ } from '../../src/security/git-baseline.js';
import { ActivityLog, formatEntry, latestTaskId } from '../../src/reporting/activity-log.js';
import { normalizeRelative, PathPolicy } from '../../src/security/path-policy.js';
import { Redactor } from '../../src/security/redact.js';
import { TaskStore } from '../../src/storage/task-store.js';
import { narrowDotnetTest } from '../../src/validation/targeted-tests.js';
import { parseTestCounts } from '../../src/validation/test-runner.js';

const tmp = (name: string) => mkdtempSync(path.join(tmpdir(), `souschef-${name}-`));
const defaults = configSchema.parse({});

test('state machine: lifecycle and terminal states', () => {
  assert.ok(canTransition('CREATED', 'QUEUED'));
  assert.ok(canTransition('RUNNING', 'VALIDATING'));
  assert.ok(canTransition('VALIDATING', 'RUNNING'), 'repair loop goes back to RUNNING');
  assert.ok(canTransition('VALIDATING', 'COMPLETED'));
  assert.ok(!canTransition('RUNNING', 'COMPLETED'), 'completion requires validation');
  assert.ok(!canTransition('COMPLETED', 'RUNNING'));
  for (const s of ['COMPLETED', 'NEEDS_REVIEW', 'FAILED', 'CANCELLED', 'TIMED_OUT'] as const) assert.ok(isTerminal(s));
});

test('path policy: globs, protected paths and traversal', () => {
  const p = new PathPolicy({ writeGlobs: defaults.writeGlobs, protectedGlobs: defaults.protectedGlobs, allowSymlinks: false });
  assert.equal(p.check('tests/OrderServiceTests.cs').allowed, true);
  assert.equal(p.check('src/Order.Tests/OrderTests.cs').allowed, true);
  assert.equal(p.check('src/math.test.ts').allowed, true);
  assert.equal(p.check('pkg/thing_test.go').allowed, true);
  assert.equal(p.check('src/Services/OrderService.cs').reason, 'outside write_globs');
  assert.equal(p.check('tests/package.json').reason, 'protected path');
  assert.equal(p.check('tests/.env').reason, 'protected path');
  assert.equal(p.check('../outside/tests/a.test.js').reason, 'path escapes the workspace');
  assert.equal(p.check('C:/x/tests/a.test.js').reason, 'path escapes the workspace');
  assert.equal(normalizeRelative('tests/../src/a.ts'), 'src/a.ts');
  assert.equal(normalizeRelative('a\\b\\c.ts'), 'a/b/c.ts');
});

test('path policy: symlinked parent directory is rejected', (t) => {
  const root = tmp('sym');
  const outside = tmp('sym-out');
  mkdirSync(path.join(root, 'real'));
  try {
    symlinkSync(outside, path.join(root, 'tests'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    t.skip('symlinks not permitted here');
    return;
  }
  writeFileSync(path.join(outside, 'a.test.js'), 'x');
  const p = new PathPolicy({ writeGlobs: defaults.writeGlobs, protectedGlobs: [], allowSymlinks: false });
  assert.equal(p.checkOnDisk(root, 'tests/a.test.js').reason, 'symlink not allowed');
});

test('command policy: allow-list and Windows shim argument guard', () => {
  const policy = new CommandPolicy([], process.env, 'linux');
  assert.ok(policy.isAllowed('dotnet'));
  assert.ok(policy.isAllowed('C:/tools/npm.cmd'));
  assert.ok(!policy.isAllowed('bash'));
  assert.throws(() => policy.resolve({ executable: 'rm', args: ['-rf', '/'], cwd: '.' }), /not allowed/);
});

test('legacy test_command is split without a shell', () => {
  assert.deepEqual(splitCommandLine('dotnet test "My App.sln" --filter Category!=SqlServer'), {
    executable: 'dotnet',
    args: ['test', 'My App.sln', '--filter', 'Category!=SqlServer'],
    cwd: '.'
  });
  assert.throws(() => splitCommandLine('npm test && rm -rf /'), /shell operators/);
  const dir = tmp('legacy');
  writeFileSync(path.join(dir, '.souschef.json'), JSON.stringify({ test_command: 'npm test', write_globs: ['spec/**'], rules: ['no db'] }));
  const cfg = loadConfig(dir);
  assert.deepEqual(cfg.test, { executable: 'npm', args: ['test'], cwd: '.' });
  assert.deepEqual(cfg.writeGlobs, ['spec/**']);
  assert.deepEqual(cfg.rules, ['no db']);
});

test('redactor removes keys, tokens and env secrets', () => {
  const r = new Redactor({ MY_API_TOKEN: 'super-secret-value-123' });
  const out = r.redact('key sk-ant-abcdefghijklmnopqrstuv token=hunter2hunter2 Bearer abcdefghijklmnop123 super-secret-value-123 AKIAABCDEFGHIJKLMNOP');
  assert.ok(!out.includes('sk-ant-abc'));
  assert.ok(!out.includes('hunter2hunter2'));
  assert.ok(!out.includes('abcdefghijklmnop123'));
  assert.ok(!out.includes('super-secret-value-123'));
  assert.ok(!out.includes('AKIAABCDEFGHIJKLMNOP'));
});

test('test count parsing for common runners', () => {
  assert.deepEqual(parseTestCounts('Passed!  - Failed:     0, Passed:    12, Skipped:     1, Total:    13, Duration: 1 s'), { failed: 0, passed: 12, skipped: 1 });
  assert.deepEqual(parseTestCounts('Tests:       1 failed, 12 passed, 13 total'), { passed: 12, failed: 1, skipped: 0 });
  assert.deepEqual(parseTestCounts('==== 2 failed, 10 passed, 1 skipped in 0.42s ===='), { passed: 10, failed: 2, skipped: 1 });
  assert.deepEqual(parseTestCounts('test result: ok. 7 passed; 0 failed; 1 ignored; 0 measured'), { passed: 7, failed: 0, skipped: 1 });
  assert.deepEqual(parseTestCounts('ℹ tests 3\nℹ pass 3\nℹ fail 0\nℹ skipped 0'), { passed: 3, failed: 0, skipped: 0 });
  assert.deepEqual(parseTestCounts('nothing useful'), {});
});

test('agy JSON result parsing tolerates surrounding log lines', () => {
  const out = 'some log\n{"conversation_id":"c1","status":"SUCCESS","response":"{}","structured_output":{"a":1}}\n';
  assert.equal(parseAgyJson(out)?.conversation_id, 'c1');
  assert.equal(parseAgyJson('no json here'), undefined);
  const stream = '{"event":"init","conversation_id":"c2","init":{}}\n{"event":"result","result":{"conversation_id":"c2","status":"SUCCESS"}}\n';
  assert.equal(parseAgyJson(stream)?.status, 'SUCCESS', 'the result event of a stream is unwrapped');
});

test('agy stream: tool steps, workspace-relative paths, command summaries and messages', () => {
  const root = path.join(tmpdir(), 'ws', 'task_1');
  const events: AgentEvent[] = [];
  const parser = new AgyStreamParser(root, (e) => events.push(e));
  const step = (update: object) => parser.push(JSON.stringify({ event: 'step_update', step_update: update }));
  const file = { name: 'write_to_file', parameters: { Path: path.join(root, 'tests', 'a.test.ts') } };
  step({ step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'write_file', tool_info: file });
  step({ step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'write_file', duration_seconds: 0.1, tool_info: file });
  const output = `Command exited with code 1.\n\nCommand output:\nsome noise\nFailed!  - Failed: 2, Passed: 5 [${root}${path.sep}App.sln]\n`;
  step({ step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { parameters: { CommandLine: `dotnet test ${root}${path.sep}App.sln` }, output } });
  step({ step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Two tests ' });
  step({ step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: 'fail.' });
  step({ step_index: 4, state: 'DONE', step_type: 'agent_response', text_delta: '{"suspectedProductBug":false}' });
  parser.push('not json');
  parser.push(JSON.stringify({ event: 'result', result: { conversation_id: 'c9', status: 'SUCCESS' } }));

  assert.deepEqual(events[0], { kind: 'tool', state: 'ACTIVE', tool: 'write_file', action: 'write', detail: 'tests/a.test.ts'.replace('/', path.sep) });
  assert.equal(events[1]!.state, 'DONE');
  assert.equal(events[2]!.action, 'run');
  assert.equal(events[2]!.detail, 'dotnet test App.sln', 'the workspace prefix is stripped from commands too');
  assert.equal(events[2]!.output, 'exit 1 · Failed!  - Failed: 2, Passed: 5 [App.sln]', 'and from command output');
  assert.deepEqual(events[3], { kind: 'message', text: 'Two tests fail.' });
  assert.equal(events.length, 4);
  assert.equal(parser.result?.conversation_id, 'c9');
  assert.equal(toolAction('replace_file_content'), 'write');
  assert.equal(toolAction('grep_search'), 'search');
  assert.equal(toolAction('view_file'), 'read');
  assert.equal(commandSummary(undefined), undefined);
  assert.equal(
    commandSummary('Command exited with code 1.\n\nCommand output:\nℹ tests 7\nℹ fail 3\nℹ todo 0\n  error: {\n    at async Test.run (node:internal/test_runner/test:1:1)\n  }\n'),
    'exit 1 · ℹ fail 3',
    'a count line beats errors, braces and stack frames'
  );
  assert.equal(commandSummary('Command exited with code 0.\n\nCommand output:\nhello\n'), 'exit 0 · hello');
});

test('activity log: redacted, filtered to headlines, formatted', () => {
  const dir = tmp('activity');
  const log = new ActivityLog(dir, (t) => t.replace('s3cret', '***'));
  log.append('t1', { kind: 'phase', phase: 'agent_writing', text: 'antigravity is writing tests' });
  log.append('t1', { kind: 'tool', state: 'ACTIVE', action: 'write', detail: 'tests/a.test.ts' });
  log.append('t1', { kind: 'tool', state: 'DONE', action: 'write', detail: 'tests/a.test.ts' });
  log.append('t1', { kind: 'tool', state: 'ACTIVE', action: 'run' });
  log.append('t1', { kind: 'tool', state: 'DONE', action: 'run', detail: 'npm test', output: 'exit 0 · token s3cret', seconds: 2 });
  log.append('t1', { kind: 'done', status: 'COMPLETED', text: 'Created 1 tests' });

  const lines = log.recent('t1', 10).map((l) => l.slice(10));
  assert.deepEqual(lines, [
    '[agent_writing] antigravity is writing tests',
    'write  tests/a.test.ts',
    '       -> exit 0 · token *** (2.0s)',
    '== COMPLETED: Created 1 tests'
  ]);
  assert.equal(log.recent('t1', 2).length, 2, 'only the tail');
  assert.deepEqual(log.recent('missing', 5), []);
  assert.equal(latestTaskId(dir), 't1');
  assert.ok(formatEntry({ at: new Date().toISOString(), kind: 'message', text: 'x'.repeat(300) }).endsWith('...'));
});

test('git name-status -z parsing splits renames into delete + add', () => {
  assert.deepEqual(parseNameStatusZ('M\0a.ts\0R100\0old.ts\0new.ts\0A\0b c.ts\0'), [
    { change: 'M', path: 'a.ts' },
    { change: 'D', path: 'old.ts' },
    { change: 'A', path: 'new.ts' },
    { change: 'A', path: 'b c.ts' }
  ]);
});

test('discovery: picks the nearest manifest and refuses to guess', () => {
  const dir = tmp('disc');
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
  writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
  mkdirSync(path.join(dir, 'src'));
  let out = discoverTestPlan(dir, defaults, ['src/a.ts']);
  assert.deepEqual(out.plan?.test, { executable: 'pnpm', args: ['test'], cwd: '.' });

  // .NET solution wins for a .cs target even with a tooling package.json at the root.
  writeFileSync(path.join(dir, 'App.sln'), '');
  mkdirSync(path.join(dir, 'src', 'Svc'));
  writeFileSync(path.join(dir, 'src', 'Svc', 'Svc.csproj'), '<Project/>');
  out = discoverTestPlan(dir, defaults, ['src/Svc/OrderService.cs']);
  assert.equal(out.plan?.ecosystem, 'dotnet');
  assert.deepEqual(out.plan?.test.args.slice(0, 2), ['test', 'App.sln']);

  // Two solutions: ambiguous, no plan.
  writeFileSync(path.join(dir, 'Other.sln'), '');
  out = discoverTestPlan(dir, defaults, ['src/Svc/OrderService.cs']);
  assert.equal(out.plan, undefined);
  assert.match(out.problem ?? '', /several solutions/);

  // Default npm script is not a test command.
  const bare = tmp('bare');
  writeFileSync(path.join(bare, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
  assert.match(discoverTestPlan(bare, defaults, []).problem ?? '', /no usable "test" script/);
});

test('discovery: monorepo modules are resolved per target and mixed targets are rejected', () => {
  const dir = tmp('mono');
  for (const m of ['api', 'web']) {
    mkdirSync(path.join(dir, m, 'src'), { recursive: true });
  }
  writeFileSync(path.join(dir, 'api', 'go.mod'), 'module api');
  writeFileSync(path.join(dir, 'web', 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
  assert.deepEqual(discoverTestPlan(dir, defaults, ['api/src/x.go']).plan?.test, { executable: 'go', args: ['test', './...'], cwd: 'api' });
  assert.equal(discoverTestPlan(dir, defaults, ['web/src/x.ts']).plan?.test.cwd, 'web');
  assert.match(discoverTestPlan(dir, defaults, ['api/src/x.go', 'web/src/x.ts']).problem ?? '', /span 2 modules/);
});

test('task store persists across reopen and makes apply idempotent', () => {
  const file = path.join(tmp('store'), 'db.sqlite');
  const s1 = new TaskStore(file);
  const now = new Date().toISOString();
  s1.insert({
    id: 't1',
    status: 'CREATED',
    phase: 'pending',
    taskType: 'tests',
    input: { taskType: 'tests', objective: 'x', projectRoot: '/p', targetPaths: [] },
    idempotencyKey: 'k',
    progress: '',
    createdAt: now,
    updatedAt: now
  });
  s1.update('t1', { status: 'COMPLETED', logs: { testOutput: 'ok' } });
  s1.replaceFiles('t1', [{ path: 'tests/a.test.js', change: 'A', allowed: true, diff: '+x' }]);
  assert.equal(s1.markApplied('t1'), true);
  assert.equal(s1.markApplied('t1'), false);
  s1.close();
  const s2 = new TaskStore(file);
  assert.equal(s2.get('t1')?.status, 'COMPLETED');
  assert.equal(s2.getLogs('t1').testOutput, 'ok');
  assert.equal(s2.getFiles('t1')[0]?.path, 'tests/a.test.js');
  s2.close();
});

test('dotnet test is narrowed to the owning test project and the changed test classes', () => {
  const root = tmp('narrow');
  mkdirSync(path.join(root, 'SkyChef', 'Tests', 'Infra.Tests', 'Orders'), { recursive: true });
  writeFileSync(path.join(root, 'SkyChef', 'Tests', 'Infra.Tests', 'Infra.Tests.csproj'), '<Project/>');
  const spec = {
    executable: 'dotnet',
    args: ['test', 'SkyChef/SkyChef.sln', '--artifacts-path', '.tools/artifacts', '-p:SkipVueBuild=true', '--filter', 'Category!=SqlServer'],
    cwd: '.'
  };
  const runs = narrowDotnetTest(
    spec,
    ['SkyChef/Tests/Infra.Tests/Orders/OrderTests.cs', 'SkyChef/Tests/Infra.Tests/Orders/LineTests.cs', 'SkyChef/Tests/Infra.Tests/data.json'],
    root,
    '.'
  );
  assert.deepEqual(runs, [
    {
      executable: 'dotnet',
      args: [
        'test',
        'SkyChef/Tests/Infra.Tests/Infra.Tests.csproj',
        '--artifacts-path',
        '.tools/artifacts',
        '-p:SkipVueBuild=true',
        '--filter',
        '(Category!=SqlServer)&(FullyQualifiedName~OrderTests|FullyQualifiedName~LineTests)'
      ],
      cwd: '.'
    }
  ]);
  assert.equal(narrowDotnetTest({ executable: 'npm', args: ['test'], cwd: '.' }, ['a.test.js'], root, '.'), undefined);
  assert.equal(narrowDotnetTest(spec, ['loose/NoProjectTests.cs'], root, '.'), undefined, 'no owning project: run everything');
});
