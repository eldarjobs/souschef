// End-to-end check against the real agent: builds a throwaway Node project with one planted bug
// (committed) plus an uncommitted change, drives the bundled server over stdio as an MCP client
// would, and prints every answer.
//
//   npm run build && npm run smoke
//
// It spends real agent time (a few minutes). The project folder is kept for inspection.

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'dist', 'server.cjs');
const project = mkdtempSync(path.join(os.tmpdir(), 'souschef-smoke-'));

function write(file, text) {
  mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
  writeFileSync(path.join(project, file), text);
}

const buggy = `export function sum(a, b) {
  return a + b;
}

export function isEven(n) {
  return n % 2 === 1;
}
`;

write('package.json', JSON.stringify({ name: 'smoke', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2));
write('src/math.js', 'export function sum(a, b) {\n  return a + b;\n}\n');
const git = (...args) =>
  execFileSync('git', ['-c', 'user.name=smoke', '-c', 'user.email=smoke@example.invalid', '-c', 'core.autocrlf=false', ...args], { cwd: project });
git('init', '-q');
git('add', '.');
git('commit', '-q', '-m', 'init');
// Not committed: SousChef must test this version.
write('src/math.js', buggy);

console.log(`project: ${project}`);

// Minimal MCP stdio client (newline-delimited JSON-RPC).
const child = spawn(process.execPath, [server], { cwd: project, env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
const pending = new Map();
let nextId = 1;
createInterface({ input: child.stdout }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

async function call(name, args) {
  const res = await request('tools/call', { name, arguments: args });
  if (res.error) throw new Error(`${name}: ${res.error.message}`);
  const text = res.result.content.map((c) => c.text).join('\n');
  if (res.result.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
}

async function follow(taskId) {
  console.log(`task ${taskId} started`);
  for (;;) {
    const view = await call('wait_for_task', { taskId, timeoutSeconds: 60 });
    console.log(`  ${view.status} / ${view.phase}: ${view.progress}`);
    if (view.finished) break;
  }
  const result = await call('get_task_result', { taskId });
  console.log(JSON.stringify(result, null, 2));
  return result;
}

await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'souschef-smoke', version: '0.0.0' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

console.log('tools:', (await request('tools/list', {})).result.tools.map((t) => t.name).join(', '));
console.log('doctor:', JSON.stringify(await call('doctor', { projectRoot: project, ping: true }), null, 2));

const first = await follow(
  (
    await call('delegate_task', {
      taskType: 'tests',
      projectRoot: project,
      targetPaths: ['src/math.js'],
      objective: [
        'Write tests in test/math.test.js using node:test and node:assert/strict.',
        'sum(2, 3) returns 5; sum(-2, -3) returns -5; sum(0, 0) returns 0.',
        'isEven(2) and isEven(0) return true; isEven(3) and isEven(-3) return false.'
      ].join(' '),
      timeoutMinutes: 15
    })
  ).taskId
);

if (first.status !== 'COMPLETED') {
  console.log('diff:', JSON.stringify(await call('get_task_diff', { taskId: first.taskId, maxChars: 4000 }), null, 2));
  write('src/math.js', buggy.replace('n % 2 === 1', 'n % 2 === 0'));
  await follow(
    (
      await call('delegate_task', {
        taskType: 'tests',
        projectRoot: project,
        targetPaths: ['src/math.js'],
        continueFrom: first.taskId,
        objective: 'You were right: isEven used `n % 2 === 1`. It is fixed to `n % 2 === 0` in src/math.js. Write the same tests again; they should pass now.',
        timeoutMinutes: 15
      })
    ).taskId
  );
}

child.kill();
