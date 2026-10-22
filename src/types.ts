// Shared domain types. Everything that crosses a module boundary lives here so
// adapters, storage and reporting agree on one vocabulary.

export const TASK_TYPES = ['tests'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/** Task types the API accepts in its schema but the engine does not run yet. */
export const PLANNED_TASK_TYPES = ['review', 'documentation', 'debugging', 'refactoring'] as const;

export type TaskStatus =
  | 'CREATED'
  | 'QUEUED'
  | 'RUNNING'
  | 'VALIDATING'
  | 'COMPLETED'
  | 'NEEDS_REVIEW'
  | 'FAILED'
  | 'CANCELLED'
  | 'TIMED_OUT';

export const TERMINAL_STATUSES: readonly TaskStatus[] = [
  'COMPLETED',
  'NEEDS_REVIEW',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT'
];

/** Fine-grained progress inside RUNNING / VALIDATING. Informational only. */
export type TaskPhase =
  | 'pending'
  | 'discovering'
  | 'preparing_workspace'
  | 'agent_writing'
  | 'agent_repairing'
  | 'building'
  | 'testing'
  | 'checking_scope'
  | 'applying'
  | 'cleanup'
  | 'done';

export type CheckStatus = 'PASSED' | 'FAILED' | 'SKIPPED' | 'NOT_RUN';

export interface DelegateInput {
  taskType: TaskType;
  objective: string;
  projectRoot: string;
  targetPaths: string[];
  maxRepairAttempts?: number;
  idempotencyKey?: string;
  timeoutMinutes?: number;
  /** Optional module root (relative to projectRoot) for monorepos. */
  module?: string;
  /** Earlier task whose agent conversation this one continues (follow-up feedback). */
  continueFrom?: string;
}

export interface CommandSpec {
  executable: string;
  args: string[];
  /** Relative to the workspace root. */
  cwd: string;
}

export interface TestPlan {
  ecosystem: string;
  moduleRoot: string;
  build?: CommandSpec;
  test: CommandSpec;
  source: 'config' | 'discovery';
  notes: string[];
  testExamples: string[];
}

export interface DiscoveryOutcome {
  plan?: TestPlan;
  /** Set when no single test command can be chosen safely. */
  problem?: string;
  candidates: Array<{ ecosystem: string; moduleRoot: string; test: CommandSpec }>;
}

export interface TestCounts {
  passed?: number;
  failed?: number;
  skipped?: number;
}

export interface CommandOutcome {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  /** Already redacted and size-limited. */
  output: string;
  truncated: boolean;
}

export interface ChangedFile {
  path: string;
  /** git name-status letter: A, M, D, R, T ... */
  change: string;
  allowed: boolean;
  reason?: string;
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
}

export interface CompactResult {
  taskId: string;
  status: TaskStatus;
  execution: CheckStatus;
  build: CheckStatus;
  tests: {
    command?: string;
    created?: number;
    passed?: number;
    failed?: number;
    exitCode?: number | null;
  };
  security: {
    status: CheckStatus;
    outOfScopeChanges: number;
    violations?: string[];
  };
  apply: {
    applied: boolean;
    reason?: string;
    conflicts?: string[];
  };
  changedFiles: string[];
  modifiedExistingTests?: string[];
  agent: {
    name: string;
    attempts: number;
    usage?: AgentUsage;
    suspectedProductBug?: boolean;
  };
  summary: string;
  /** Why the task did not complete cleanly (discovery problem, agent error, ...). */
  reason?: string;
}

export interface TaskRecord {
  id: string;
  status: TaskStatus;
  phase: TaskPhase;
  taskType: TaskType;
  input: DelegateInput;
  idempotencyKey: string;
  progress: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  pid?: number;
  workspacePath?: string;
  error?: string;
  result?: CompactResult;
  appliedAt?: string;
}
