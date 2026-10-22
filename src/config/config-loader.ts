import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';

export const CONFIG_FILE = '.souschef.json';

const commandSchema = z.object({
  executable: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().default('.')
});

const moduleSchema = z.object({
  /** Module root relative to the project root. */
  root: z.string(),
  build: commandSchema.optional(),
  test: commandSchema.optional(),
  writeGlobs: z.array(z.string()).optional()
});

export const DEFAULT_WRITE_GLOBS = [
  '**/test/**',
  '**/tests/**',
  '**/__tests__/**',
  '**/spec/**',
  '**/*.Tests/**',
  '**/*.Test/**',
  '**/*.UnitTests/**',
  '**/*.IntegrationTests/**',
  '**/*.test.*',
  '**/*.spec.*',
  '**/*_test.go',
  '**/test_*.py',
  '**/*_test.py',
  '**/conftest.py',
  '**/*Tests.cs',
  '**/*Test.cs',
  '**/*Test.java',
  '**/*Tests.java'
];

/** Never writable, even when a write glob matches. */
export const DEFAULT_PROTECTED_GLOBS = [
  '.git/**',
  '**/.git/**',
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  CONFIG_FILE,
  '.github/**',
  '.gitlab-ci.yml',
  '**/package.json',
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
  '**/bun.lockb',
  '**/*.sln',
  '**/Directory.Build.props',
  '**/Directory.Packages.props',
  '**/pyproject.toml',
  '**/go.mod',
  '**/go.sum',
  '**/Cargo.toml',
  '**/Cargo.lock'
];

export const configSchema = z.object({
  agent: z
    .object({
      adapter: z.enum(['agy']).default('agy'),
      /** Override the agent binary, e.g. an absolute path to agy. */
      executable: z.string().optional(),
      /** Arguments placed before the adapter's own arguments (used by test doubles). */
      prefixArgs: z.array(z.string()).default([]),
      model: z.string().optional(),
      effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
      /**
       * skip-permissions: auto-approve tool calls. Print mode has nobody to answer prompts, so
       *   this is the mode in which agy runs unattended; the isolated workspace and the scope
       *   check afterwards are what contain it.
       * skip-permissions-sandboxed: the same plus agy's --sandbox terminal restrictions.
       * accept-edits: file edits only; any other tool call stalls until --print-timeout.
       */
      permissionMode: z.enum(['skip-permissions', 'skip-permissions-sandboxed', 'accept-edits']).default('skip-permissions'),
      extraArgs: z.array(z.string()).default([]),
      timeoutMinutes: z.number().positive().default(20)
    })
    .default({ adapter: 'agy', prefixArgs: [], permissionMode: 'skip-permissions', extraArgs: [], timeoutMinutes: 20 }),
  build: commandSchema.optional(),
  test: commandSchema.optional(),
  modules: z.array(moduleSchema).default([]),
  writeGlobs: z.array(z.string()).default(DEFAULT_WRITE_GLOBS),
  protectedGlobs: z.array(z.string()).default(DEFAULT_PROTECTED_GLOBS),
  /** Extra executables (besides the discovered toolchains) that may be run. */
  allowedExecutables: z.array(z.string()).default([]),
  /** Apply verified test-only changes back into the user's checkout. */
  autoApply: z.boolean().default(true),
  allowSymlinks: z.boolean().default(false),
  allowDeletions: z.boolean().default(false),
  maxRepairAttempts: z.number().int().min(0).max(5).default(2),
  taskTimeoutMinutes: z.number().positive().default(45),
  commandTimeoutMinutes: z.number().positive().default(15),
  maxOutputBytes: z.number().int().positive().default(256_000),
  /** Directories linked (not copied) into the workspace so builds work offline. */
  linkDirs: z.array(z.string()).default(['node_modules', '.venv', 'venv']),
  /** Excluded when the project is not a git repository and must be copied. */
  copyExclude: z
    .array(z.string())
    .default(['.git', 'node_modules', '.venv', 'venv', 'bin', 'obj', 'target', 'dist', '__pycache__', '.pytest_cache']),
  keepWorkspace: z.boolean().default(false),
  /** Extra project rules appended to every agent prompt. */
  rules: z.array(z.string()).default([])
});

export type SousChefConfig = z.infer<typeof configSchema>;
export type ModuleConfig = z.infer<typeof moduleSchema>;

export interface SousChefEnvironment {
  dataDir: string;
  workspaceRoot: string;
  maxConcurrentTasks: number;
}

export function loadConfig(projectRoot: string): SousChefConfig {
  const file = path.join(projectRoot, CONFIG_FILE);
  if (!existsSync(file)) return configSchema.parse({});
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${CONFIG_FILE} is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = configSchema.safeParse(upgradeLegacyKeys(raw));
  if (!parsed.success) {
    throw new Error(`${CONFIG_FILE} is invalid: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/** Maps v1 `.souschef.json` keys (snake_case, shell-style test_command) onto the current schema. */
function upgradeLegacyKeys(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const { test_command, write_globs, timeout_minutes, adapter, ...rest } = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { ...rest };
  if (typeof test_command === 'string' && out.test === undefined) out.test = splitCommandLine(test_command);
  if (Array.isArray(write_globs) && out.writeGlobs === undefined) out.writeGlobs = write_globs;
  if (typeof timeout_minutes === 'number' && out.taskTimeoutMinutes === undefined) out.taskTimeoutMinutes = timeout_minutes;
  if (typeof adapter === 'string' && out.agent === undefined) out.agent = { adapter };
  return out;
}

/** Splits `dotnet test My.sln --filter X` into executable + args. Quotes group words; nothing else is interpreted. */
export function splitCommandLine(line: string): { executable: string; args: string[]; cwd: string } {
  const tokens = [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? '');
  if (tokens.some((t) => /^(\||\|\||&&|;|>|>>|<)$/.test(t) || /[`$]/.test(t))) {
    throw new Error('test_command may not contain shell operators; use "test": { "executable", "args" } instead.');
  }
  const [executable, ...args] = tokens;
  if (!executable) throw new Error('test_command is empty');
  return { executable, args, cwd: '.' };
}

export function loadEnvironment(env: NodeJS.ProcessEnv = process.env): SousChefEnvironment {
  // Windows tmpdir() can be an 8.3 short path (LONGNA~1) while git reports long paths;
  // resolving it once keeps every later path comparison consistent.
  const workspaceRoot = env.SOUSCHEF_WORKSPACE_DIR ?? path.join(tmpdir(), 'souschef');
  mkdirSync(workspaceRoot, { recursive: true });
  return {
    dataDir: env.SOUSCHEF_DATA_DIR ?? path.join(homedir(), '.souschef'),
    workspaceRoot: realpathSync.native(workspaceRoot),
    maxConcurrentTasks: Math.max(1, Number(env.SOUSCHEF_MAX_CONCURRENT ?? 1) || 1)
  };
}
