import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getAdapter } from "./adapters.js";
import { gitTopLevel } from "./git.js";
import { CONFIG_FILE, loadProject } from "./project.js";
import { RunManager } from "./runs.js";

const VERSION = "0.1.0";
const execFileAsync = promisify(execFile);
const runs = new RunManager();

const cwdParam = z
  .string()
  .optional()
  .describe("Absolute path of the project root. Defaults to the server's working directory; pass it explicitly when in doubt.");

function resolveRoot(cwd?: string): string {
  const root = path.resolve(cwd ?? process.env.SOUSCHEF_ROOT ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`Project root '${root}' is not a directory.`);
  // Expands Windows 8.3 names (C:\Users\LONGNA~1): git reports long paths, and the two
  // spellings of one folder would make every changed file look like it sits outside the project.
  return realpathSync.native(root);
}

function reply(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

/** Every tool answers with JSON, and a thrown error becomes a readable tool error rather than a crash. */
function tool<A>(handler: (args: A) => Promise<unknown> | unknown) {
  return async (args: A) => {
    try {
      return reply(await handler(args));
    } catch (error) {
      return { isError: true, content: [{ type: "text" as const, text: (error as Error).message }] };
    }
  };
}

async function doctor(root: string, adapterId: string | undefined, ping: boolean) {
  const project = loadProject(root);
  const adapter = getAdapter(adapterId ?? project.adapter);
  const binary = adapter.locate();
  const top = await gitTopLevel(root);
  const hints: string[] = [];

  const report: Record<string, unknown> = {
    adapter: adapter.id,
    binary: binary ?? null,
    version: null,
    signed_in: null,
    project: {
      root,
      git: Boolean(top),
      config_file: project.configPath ?? null,
      test_command: project.testCommand || null,
      write_globs: project.writeGlobs,
      rules: project.rules,
      detected_from: project.source,
    },
    hints,
  };

  if (!top) hints.push("Not a git repository: progress events and the write guard need git.");
  if (project.source === "none") hints.push(`No test setup detected. Add ${CONFIG_FILE} with test_command and write_globs.`);
  if (!binary) {
    hints.push(adapter.installHint);
    return report;
  }

  try {
    const { stdout } = await execFileAsync(binary, ["--version"], { timeout: 20_000, windowsHide: true });
    report.version = stdout.trim();
  } catch {
    // older builds without --version
  }

  if (ping) {
    // A throwaway folder: agy leaves a logs/ folder wherever it runs.
    const scratch = mkdtempSync(path.join(os.tmpdir(), "souschef-doctor-"));
    const started = Date.now();
    try {
      const { stdout } = await execFileAsync(
        binary,
        adapter.args({
          prompt: "Reply with exactly the single word PONG and nothing else. Do not use any tools.",
          logFile: path.join(scratch, "agent.log"),
          timeoutMinutes: 2,
        }),
        { cwd: scratch, timeout: 180_000, windowsHide: true },
      );
      report.signed_in = stdout.includes("PONG");
    } catch {
      report.signed_in = false;
    } finally {
      report.ping_seconds = Math.round((Date.now() - started) / 1000);
      rmSync(scratch, { recursive: true, force: true });
    }
    if (report.signed_in === false) {
      hints.push(`${adapter.name} gave no answer. Run it once in a terminal and sign in, then call doctor again.`);
    }
  }
  return report;
}

async function main(): Promise<void> {
  const server = new McpServer({ name: "souschef", version: VERSION });

  server.registerTool(
    "doctor",
    {
      title: "Check the tester agent",
      description:
        "Checks that the tester agent CLI is installed and signed in, and shows what souschef detected about the project " +
        "(test command, folders the agent may write to). With ping=true (default) it sends one tiny prompt, which takes ~30 seconds. " +
        "Call it once before the first run in a session, or when a run ends in error.",
      inputSchema: {
        ping: z.boolean().optional().describe("Send a one-word prompt to prove the agent is signed in. Default true."),
        adapter: z.string().optional().describe("Agent backend. Default from the project config, else 'agy'."),
        cwd: cwdParam,
      },
    },
    tool(async ({ ping, adapter, cwd }: { ping?: boolean; adapter?: string; cwd?: string }) =>
      doctor(resolveRoot(cwd), adapter, ping ?? true)),
  );

  server.registerTool(
    "start_run",
    {
      title: "Hand tests to the tester agent",
      description:
        "Starts the tester agent in the background on this project: it writes tests for the change you describe, runs them and reports back. " +
        "Returns immediately with a run_id and a cursor. Then call wait_run repeatedly until state is no longer 'running'. " +
        "Write the requirements the way you would brief a colleague: one concrete, checkable behaviour per item, with inputs, expected outcome and edge cases. " +
        "Do not edit the files under test while the run is in progress.",
      inputSchema: {
        feature: z.string().min(1).describe("One line: what was built or changed."),
        requirements: z
          .array(z.string().min(1))
          .min(1)
          .describe("One testable behaviour per item. Items starting with 'SETUP:' or 'RUN:' tell the agent where tests go or how to run them."),
        changed_files: z.array(z.string()).optional().describe("Paths of the code under test, relative to the project root."),
        notes: z.string().optional().describe("Anything else the tester should know."),
        test_command: z.string().optional().describe("Overrides the configured or detected test command for this run."),
        write_globs: z.array(z.string()).optional().describe("Overrides where the agent may write, as globs relative to the project root."),
        timeout_minutes: z.number().int().min(1).max(240).optional().describe("Agent time limit. Default from config, else 60."),
        adapter: z.string().optional().describe("Agent backend. Default from the project config, else 'agy'."),
        cwd: cwdParam,
      },
    },
    tool(async (args: {
      feature: string;
      requirements: string[];
      changed_files?: string[];
      notes?: string;
      test_command?: string;
      write_globs?: string[];
      timeout_minutes?: number;
      adapter?: string;
      cwd?: string;
    }) =>
      runs.start({
        root: resolveRoot(args.cwd),
        task: { feature: args.feature, requirements: args.requirements, changedFiles: args.changed_files ?? [], notes: args.notes },
        adapter: args.adapter,
        testCommand: args.test_command,
        writeGlobs: args.write_globs,
        timeoutMinutes: args.timeout_minutes,
      })),
  );

  server.registerTool(
    "wait_run",
    {
      title: "Wait for the tester agent",
      description:
        "Blocks until something happens in the run (a test file written, the agent finishing) or max_wait_seconds pass, then returns the new events " +
        "and a cursor. Call it again with that cursor while state is 'running', and tell the user in one line what moved. " +
        "When state is passed, failed, error, cancelled or timeout, the answer also carries the agent's result (tests added, failures, " +
        "suspected_source_bugs) and out_of_scope: files changed outside the allowed test folders.",
      inputSchema: {
        run_id: z.string(),
        cursor: z.number().int().min(0).optional().describe("The cursor from the previous answer. Default 0 (all events)."),
        max_wait_seconds: z.number().int().min(1).max(1800).optional().describe("Default 300."),
        return_on_event: z
          .boolean()
          .optional()
          .describe("Default true: return as soon as there are new events. False: wait for the end or the time limit."),
        cwd: cwdParam,
      },
    },
    tool(async ({ run_id, cursor, max_wait_seconds, return_on_event, cwd }: {
      run_id: string;
      cursor?: number;
      max_wait_seconds?: number;
      return_on_event?: boolean;
      cwd?: string;
    }) => runs.wait(resolveRoot(cwd), run_id, cursor ?? 0, max_wait_seconds ?? 300, return_on_event ?? true)),
  );

  server.registerTool(
    "continue_run",
    {
      title: "Send feedback to the tester agent",
      description:
        "Starts a follow-up run in the same agent conversation (when the backend supports resuming), e.g. after you fixed the production bugs it " +
        "reported, or to ask it to fix its own tests. The previous run must have ended. Returns a new run_id: wait on that one.",
      inputSchema: {
        run_id: z.string().describe("The run to follow up."),
        feedback: z.string().min(1).describe("What changed and what you want now. Be specific: name files, tests and requirements."),
        timeout_minutes: z.number().int().min(1).max(240).optional(),
        cwd: cwdParam,
      },
    },
    tool(async ({ run_id, feedback, timeout_minutes, cwd }: { run_id: string; feedback: string; timeout_minutes?: number; cwd?: string }) =>
      runs.continueRun(resolveRoot(cwd), run_id, feedback, timeout_minutes)),
  );

  server.registerTool(
    "cancel_run",
    {
      title: "Stop the tester agent",
      description: "Stops a running agent and everything it started. Test files it already wrote stay where they are.",
      inputSchema: { run_id: z.string(), cwd: cwdParam },
    },
    tool(async ({ run_id, cwd }: { run_id: string; cwd?: string }) => runs.cancel(resolveRoot(cwd), run_id)),
  );

  server.registerTool(
    "list_runs",
    {
      title: "Recent tester runs",
      description: "Lists the most recent runs in this project, newest first.",
      inputSchema: { limit: z.number().int().min(1).max(100).optional().describe("Default 10."), cwd: cwdParam },
    },
    tool(async ({ limit, cwd }: { limit?: number; cwd?: string }) => runs.list(resolveRoot(cwd), limit ?? 10)),
  );

  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
