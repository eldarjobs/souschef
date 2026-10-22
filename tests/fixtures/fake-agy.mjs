// Stand-in for `agy --print ... --output-format json`, driven by FAKE_AGY_MODE.
// Writes files into its cwd (the SousChef workspace) and prints agy's JSON result shape.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const prompt = args[args.indexOf('--print') + 1] ?? '';
const resumed = args.includes('--conversation');
const isRepair = prompt.includes('Repair attempt');
const mode = process.env.FAKE_AGY_MODE ?? 'pass';

const write = (rel, text) => {
  mkdirSync(path.dirname(rel), { recursive: true });
  writeFileSync(rel, text);
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

process.stdout.write(
  JSON.stringify({
    conversation_id: 'fake-conversation-1',
    status: 'SUCCESS',
    response: JSON.stringify(report),
    structured_output: report,
    num_turns: 1,
    duration_seconds: 0.1,
    usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 5, cache_read_tokens: 0, total_tokens: 125 }
  }) + '\n'
);
