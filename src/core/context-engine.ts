import type { TestPlan } from '../types.js';
import { formatCommand } from '../validation/test-runner.js';

/** Final answer every agent must return; enforced through the adapter's JSON schema support. */
export const AGENT_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'One or two sentences on what was done.' },
    testsCreated: { type: 'integer', minimum: 0, description: 'Number of new test cases written in this turn.' },
    testFiles: { type: 'array', items: { type: 'string' }, description: 'Repo-relative paths of test files created or edited.' },
    suspectedProductBug: {
      type: 'boolean',
      description: 'True if a test fails because the production code is wrong, not the test.'
    },
    productBugDetails: { type: 'string', description: 'Short evidence for the suspected product bug, empty otherwise.' }
  },
  required: ['summary', 'testsCreated', 'testFiles', 'suspectedProductBug', 'productBugDetails']
} as const;

export interface AgentReport {
  summary: string;
  testsCreated: number;
  testFiles: string[];
  suspectedProductBug: boolean;
  productBugDetails: string;
}

export function readAgentReport(value: unknown): AgentReport | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  return {
    summary: typeof v.summary === 'string' ? v.summary.slice(0, 600) : '',
    testsCreated: typeof v.testsCreated === 'number' && v.testsCreated >= 0 ? Math.floor(v.testsCreated) : 0,
    testFiles: Array.isArray(v.testFiles) ? v.testFiles.filter((f): f is string => typeof f === 'string').slice(0, 50) : [],
    suspectedProductBug: v.suspectedProductBug === true,
    productBugDetails: typeof v.productBugDetails === 'string' ? v.productBugDetails.slice(0, 1200) : ''
  };
}

export interface PromptContext {
  objective: string;
  targetPaths: string[];
  /** Files the user changed but has not committed (repo-relative). */
  uncommittedChanges: string[];
  plan: TestPlan;
  writeGlobs: string[];
  projectSubdir: string;
  /** Project-specific rules from .souschef.json. */
  rules: string[];
}

function rulesBlock(ctx: PromptContext): string {
  const base = RULES.replace('{GLOBS}', ctx.writeGlobs.join(', '));
  return ctx.rules.length > 0 ? `${base}\n${ctx.rules.map((r) => `- ${r}`).join('\n')}` : base;
}

const RULES = `Hard rules:
- Only create or edit test files. Allowed paths (glob): {GLOBS}
- Never modify production/business code, build manifests, lockfiles, CI files or configuration.
- Never delete existing tests and never weaken assertions to make tests pass.
- Do not install packages or change dependencies.
- Follow the conventions of the existing tests (framework, naming, folder layout).
- SousChef runs the full test command itself after you finish. Builds and test runs are slow:
  when you run tests yourself, build and run only the test project you changed, filtered to the
  tests you wrote (e.g. dotnet test <project> --filter FullyQualifiedName~<YourTestClass>),
  never the whole solution, and do not re-run them without a change in between.
- The uncommitted changes listed above are already in your working copy: read those files
  directly. git status/diff here is slow and shows nothing more.`;

/** Builds a minimal, self-contained prompt: paths and rules, no pasted source. */
export function buildInitialPrompt(ctx: PromptContext): string {
  const where = (p: string) => (ctx.projectSubdir ? `${ctx.projectSubdir}/${p}` : p);
  const lines = [
    'You are writing automated tests in this repository.',
    '',
    `Objective: ${ctx.objective}`,
    '',
    'Code under test:',
    ...(ctx.targetPaths.length > 0 ? ctx.targetPaths.map((p) => `- ${where(p)}`) : ['- (not specified: inspect the uncommitted changes)'])
  ];
  if (ctx.uncommittedChanges.length > 0) {
    lines.push('', 'Uncommitted changes in the working tree (likely what needs coverage):', ...ctx.uncommittedChanges.slice(0, 30).map((p) => `- ${p}`));
  }
  if (ctx.plan.testExamples.length > 0) {
    lines.push('', 'Existing tests to copy conventions from:', ...ctx.plan.testExamples.map((p) => `- ${where(p)}`));
  }
  lines.push(
    '',
    `Test command (run from ${ctx.plan.test.cwd === '.' ? 'the module root' : ctx.plan.test.cwd}): ${formatCommand(ctx.plan.test)}`,
    ...(ctx.plan.build ? [`Build command: ${formatCommand(ctx.plan.build)}`] : []),
    '',
    rulesBlock(ctx),
    '',
    'If the code under test is itself wrong, keep the test that exposes it, set suspectedProductBug=true and explain briefly.',
    'Finish with the structured JSON answer.'
  );
  return lines.join('\n');
}

export function buildRepairPrompt(ctx: PromptContext, failureOutput: string, attempt: number, maxAttempts: number): string {
  return [
    `Repair attempt ${attempt} of ${maxAttempts}. The tests you wrote failed when SousChef ran them.`,
    '',
    'Failure output (truncated):',
    '```',
    failureOutput,
    '```',
    '',
    'Fix genuine problems in the TEST code only (compile errors, wrong setup, wrong API usage).',
    'If a failure shows the production code is wrong, do not change the expectation: set suspectedProductBug=true.',
    '',
    rulesBlock(ctx),
    '',
    'Finish with the structured JSON answer.'
  ].join('\n');
}

/** Keeps the end of a failure log (where runners print failures), capped for the repair prompt. */
export function tailForRepair(output: string, maxChars = 6000): string {
  return output.length <= maxChars ? output : '...\n' + output.slice(output.length - maxChars);
}
