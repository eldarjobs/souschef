import type { ProjectSettings } from "./project.js";

export interface TestTask {
  feature: string;
  requirements: string[];
  changedFiles: string[];
  notes?: string;
}

const RESULT_SHAPE = `{
  "status": "passed | failed | error",
  "tests_added": ["path/to/new/test/file"],
  "command": "the exact test command of your final run",
  "summary": { "total": 0, "passed": 0, "failed": 0, "skipped": 0 },
  "failures": [ { "test": "fully qualified test name", "message": "first line of the failure" } ],
  "suspected_source_bugs": [
    { "file": "path/to/production/file", "requirement": "the requirement text", "detail": "what the code does vs what was required" }
  ],
  "uncovered_requirements": [ "requirement you could not cover, and why" ],
  "notes": "short free text: decisions you made, anything the developer should know"
}`;

function bullets(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

export function renderBrief(runId: string, task: TestTask, settings: ProjectSettings, resultPath: string): string {
  const files = task.changedFiles.length
    ? bullets(task.changedFiles.map((f) => `\`${f}\``))
    : "Not listed. Work them out from `git status` and `git diff`.";
  const requirements = task.requirements.map((r, i) => `${i + 1}. ${r}`).join("\n");
  const projectRules = settings.rules.length
    ? `\n\nProject-specific rules:\n${bullets(settings.rules)}`
    : "";
  const command = settings.testCommand
    ? `Run the tests with:\n\n    ${settings.testCommand}\n\nWhile iterating you may narrow it to the new tests.`
    : "No test command is configured. Find out how this project runs its tests (README, CI config, package manifest) and use that.";

  return `# Test brief - run ${runId}

You are the tester on this project. Another coding agent implemented the change below and handed
the testing to you. Write the tests, run them, and report back in the result file. Nobody is
watching interactively: do not ask questions. Decide, and write your decisions in \`notes\`.

## The change

**Feature:** ${task.feature}

**Code under test:**
${files}
${task.notes ? `\n**Notes from the developer:** ${task.notes}\n` : ""}
## What to test

${requirements}

## Rules

1. Create or change files ONLY inside these paths (relative to the project root):
${settings.writeGlobs.map((g) => `   - \`${g}\``).join("\n")}
   Never edit production code. If a test project needs a new dependency, you may edit that test
   project's manifest when it lies inside the paths above.
2. Do not delete, skip or weaken existing tests.
3. Do not change git state: no add, commit, stash, checkout, reset or clean.
4. Never kill processes.
5. Match the existing tests: framework, folder layout, naming.
6. A test that fails because the PRODUCTION code contradicts a requirement is a finding. Keep the
   test as written (do not weaken or skip it) and list it under \`suspected_source_bugs\`.
7. A test that fails because the TEST is wrong: fix the test.${projectRules}

## Running the tests

${command}

Finish with one run that includes all the tests you added, and report THAT run.

## Report

The LAST thing you do is write \`${resultPath}\` as UTF-8 JSON in exactly this shape:

\`\`\`json
${RESULT_SHAPE}
\`\`\`

- \`passed\`: every test you added passed. \`failed\`: at least one failed. \`error\`: you could not
  build or run the tests.
- \`summary\` counts only your final run.

Then reply with a three-line summary.
`;
}

export function renderFollowUp(
  runId: string,
  parentRunId: string,
  parentBriefPath: string,
  parentResultPath: string,
  feedback: string,
  resultPath: string,
): string {
  return `# Follow-up - run ${runId} (continues run ${parentRunId})

The original brief is \`${parentBriefPath}\`. Every rule in it still applies. Your previous report
is \`${parentResultPath}\`.

## Feedback from the developer

${feedback}

## What to do

Act on the feedback, run the tests again, and write a fresh, complete report (same JSON shape as in
the original brief) to \`${resultPath}\` as the LAST thing you do. Then reply with a three-line summary.
`;
}
