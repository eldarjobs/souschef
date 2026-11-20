// Stand-in for `agy --print ... --output-format stream-json|json`, driven by FAKE_AGY_MODE.
// Writes files into its cwd (the SousChef workspace) and prints agy's output shapes:
// step_update events per tool call and a final result event, or one JSON object.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const prompt = args[args.indexOf('--print') + 1] ?? '';
const resumed = args.includes('--conversation');
const isRepair = prompt.includes('Repair attempt');
const mode = process.env.FAKE_AGY_MODE ?? 'pass';
const streaming = args[args.indexOf('--output-format') + 1] === 'stream-json';

// Like agy, a step reports ACTIVE and then DONE under the same step_index.
let steps = 0;
const emit = (event) => streaming && process.stdout.write(JSON.stringify(event) + '\n');
const stepUpdate = (index, update) =>
  emit({ event: 'step_update', step_update: { conversation_id: 'fake-conversation-1', step_index: index, ...update } });
emit({ event: 'init', conversation_id: 'fake-conversation-1', init: { cwd: process.cwd(), tools: ['write_to_file', 'run_command'] } });

const write = (rel, text) => {
  const index = steps++;
  const tool_info = { name: 'write_to_file', parameters: { Path: path.resolve(rel) } };
  stepUpdate(index, { state: 'ACTIVE', step_type: 'tool', tool_name: 'write_file', tool_info });
  mkdirSync(path.dirname(rel), { recursive: true });
  writeFileSync(rel, text);
  stepUpdate(index, { state: 'DONE', step_type: 'tool', tool_name: 'write_file', duration_seconds: 0.01, tool_info });
};

const passingTest = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add, isEven } from '../src/math.js';
test('add', () => assert.equal(add(2, 3), 5));
test('isEven', () => assert.equal(isEven(4), true));
`;
const failingTest = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add } from '../src/math.js';
test('add is wrong on purpose', () => assert.equal(add(2, 2), 5));
`;

let report = { summary: 'wrote tests', testsCreated: 2, testFiles: ['test/math.test.js'], suspectedProductBug: false, productBugDetails: '' };

switch (mode) {
  case 'pass':
    write('test/math.test.js', passingTest);
    break;
  case 'out-of-scope':
    write('test/math.test.js', passingTest);
    write('src/math.js', 'export const add = () => 0;\n');
    break;
  case 'repair':
    write('test/math.test.js', isRepair && resumed ? passingTest : failingTest);
    break;
  case 'always-fail':
    write('test/math.test.js', failingTest);
    break;
  case 'product-bug':
    write('test/math.test.js', failingTest);
    report = { ...report, suspectedProductBug: true, productBugDetails: 'add(2,2) should be 4 but the spec says 5' };
    break;
  case 'conflict': {
    write('test/math.test.js', passingTest);
    // Simulates the user editing the same file in the real checkout meanwhile.
    write(path.join(process.env.FAKE_AGY_MAIN_ROOT, 'test/math.test.js'), '// user edit\n');
    break;
  }
  case 'sleep':
    await new Promise((r) => setTimeout(r, 60_000));
    break;
  case 'crash':
    process.stderr.write('boom\n');
    process.exit(3);
  case 'no-change':
    break;
}

const commandOutput = 'Command exited with code 0.\n\nCommand output:\nℹ tests 2\nℹ pass 2';
const run = { name: 'run_command', parameters: { CommandLine: 'node --test' } };
const runStep = steps++;
stepUpdate(runStep, { state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: run });
stepUpdate(runStep, { state: 'DONE', step_type: 'tool', tool_name: 'run_command', duration_seconds: 0.4, tool_info: { ...run, output: commandOutput } });
const messageStep = steps++;
stepUpdate(messageStep, { state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Tests written ' });
stepUpdate(messageStep, { state: 'DONE', step_type: 'agent_response', text_delta: 'and run.' });

const result = {
  conversation_id: 'fake-conversation-1',
  status: 'SUCCESS',
  response: JSON.stringify(report),
  structured_output: report,
  num_turns: 1,
  duration_seconds: 0.1,
  usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 5, cache_read_tokens: 0, total_tokens: 125 }
};
process.stdout.write(JSON.stringify(streaming ? { event: 'result', result } : result) + '\n');
