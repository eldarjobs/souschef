import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, realpathSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import type { AgentEvent } from '../adapters/agent-adapter.js';
import { loadConfig } from '../config/config-loader.js';
import type { ActivityLog } from '../reporting/activity-log.js';
import { captureBaseline } from '../security/git-baseline.js';
import type { TaskStore } from '../storage/task-store.js';
import { TASK_TYPES, type DelegateInput, type TaskPhase, type TaskRecord, type TaskStatus } from '../types.js';
import { runTestsPipeline, type PipelineDeps, type PipelineOutcome } from './pipeline.js';
import type { ProcessRegistry } from './process-runner.js';
import { assertTransition, isTerminal } from './state-machine.js';

export interface TaskManagerOptions {
  store: TaskStore;
  registry: ProcessRegistry;
  pipeline: PipelineDeps;
  workspaceRoot: string;
  maxConcurrentTasks: number;
  /** Fallback task timeout when the project config cannot be read yet. */
  defaultTaskTimeoutMinutes?: number;
  /** Live per-task activity (phases and agent steps) for wait_for_task and `souschef watch`. */
  activity?: ActivityLog;
}

export interface DelegateResponse {
  taskId: string;
  status: TaskStatus;
  deduplicated: boolean;
}

interface Active {
  cancelled: boolean;
  timedOut: boolean;
  timer?: NodeJS.Timeout;
}

/**
 * The single owner of task state. Every MCP tool goes through this class; nothing
 * else writes task status.
 */
export class TaskManager {
  private readonly events = new EventEmitter();
  private readonly queue: string[] = [];
  private readonly active = new Map<string, Active>();
  private running = 0;

  constructor(private readonly opts: TaskManagerOptions) {
    this.events.setMaxListeners(0);
  }

  /** Called once at startup: tasks that were mid-flight when the server died cannot be resumed. */
  recover(): number {
    const stale = this.opts.store.listByStatus(['CREATED', 'QUEUED', 'RUNNING', 'VALIDATING']);
    for (const t of stale) {
      this.opts.store.update(t.id, {
        status: 'FAILED',
        phase: 'done',
        finishedAt: new Date().toISOString(),
        error: 'SousChef restarted while this task was active; delegate it again.',
        pid: null
      });
      if (t.workspacePath && existsSync(t.workspacePath) && path.dirname(t.workspacePath) === this.opts.workspaceRoot) {
        // Links into node_modules/.venv are junctions/symlinks; rmSync removes the link, not the target.
        rmSync(t.workspacePath, { recursive: true, force: true });
      }
    }
    return stale.length;
  }

  async delegate(raw: DelegateInput): Promise<DelegateResponse> {
    if (!TASK_TYPES.includes(raw.taskType)) throw new Error(`Task type "${raw.taskType}" is not supported yet.`);
    const resolved = path.resolve(raw.projectRoot);
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) throw new Error(`projectRoot "${raw.projectRoot}" is not a directory`);
    // Long, canonical path: Windows 8.3 names (LONGNA~1) would not match what git reports.
    const projectRoot = realpathSync.native(resolved);
    if (raw.continueFrom) {
      const prev = this.opts.store.get(raw.continueFrom);
      if (!prev) throw new Error(`continueFrom: unknown task ${raw.continueFrom}`);
      if (!isTerminal(prev.status)) throw new Error(`continueFrom: task ${raw.continueFrom} is still ${prev.status}`);
      if (!this.opts.store.getLogs(prev.id).agentSessionId) throw new Error(`continueFrom: task ${raw.continueFrom} has no agent conversation to continue`);
    }
    const input: DelegateInput = { ...raw, projectRoot, targetPaths: raw.targetPaths ?? [] };

    const explicitKey = input.idempotencyKey?.trim();
    const key = explicitKey ? `user:${explicitKey}` : `auto:${await fingerprint(input)}`;
    const existing = this.opts.store.findByIdempotencyKey(key);
    // An explicit key always returns the same task; a derived key only dedupes work in flight.
    const reuse = explicitKey ? existing[0] : existing.find((t) => !isTerminal(t.status));
    if (reuse) return { taskId: reuse.id, status: reuse.status, deduplicated: true };

    const now = new Date().toISOString();
    const task: TaskRecord = {
      id: `task_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`,
      status: 'CREATED',
      phase: 'pending',
      taskType: input.taskType,
      input,
      idempotencyKey: key,
      progress: 'Created',
      createdAt: now,
      updatedAt: now
    };
    this.opts.store.insert(task);
    this.transition(task.id, 'QUEUED', { progress: 'Waiting for a free slot' });
    // Written right away so a watcher started with the taskId has a file to follow.
    this.opts.activity?.append(task.id, { kind: 'phase', phase: 'queued', text: 'Waiting for a free slot' });
    this.queue.push(task.id);
    setImmediate(() => this.pump());
    return { taskId: task.id, status: 'QUEUED', deduplicated: false };
  }

  get(taskId: string): TaskRecord | undefined {
    return this.opts.store.get(taskId);
  }

  /** The latest steps of a task, one formatted line each, oldest first. */
  activity(taskId: string, limit: number): string[] {
    return this.opts.activity?.recent(taskId, limit) ?? [];
  }

  /** Resolves when the task is terminal or the timeout passes. */
  async waitFor(taskId: string, timeoutMs: number): Promise<TaskRecord | undefined> {
    const current = this.get(taskId);
    if (!current || isTerminal(current.status)) return current;
    return new Promise((resolve) => {
      const onChange = (id: string) => {
        if (id !== taskId) return;
        const t = this.get(taskId);
        if (t && isTerminal(t.status)) finish(t);
      };
      const timer = setTimeout(() => finish(this.get(taskId)), timeoutMs);
      const finish = (t: TaskRecord | undefined) => {
        clearTimeout(timer);
        this.events.off('change', onChange);
        resolve(t);
      };
      this.events.on('change', onChange);
    });
  }

  cancel(taskId: string): { taskId: string; status: TaskStatus; killedProcesses: number } {
    const task = this.get(taskId);
    if (!task) throw new Error(`Unknown task ${taskId}`);
    if (isTerminal(task.status)) return { taskId, status: task.status, killedProcesses: 0 };
    const queued = this.queue.indexOf(taskId);
    if (queued >= 0) {
      this.queue.splice(queued, 1);
      this.finish(taskId, { status: 'CANCELLED', result: undefined, error: 'Cancelled before start' });
      return { taskId, status: 'CANCELLED', killedProcesses: 0 };
    }
    const active = this.active.get(taskId);
    if (active) active.cancelled = true;
    const killed = this.opts.registry.cancel(taskId);
    return { taskId, status: this.get(taskId)?.status ?? task.status, killedProcesses: killed };
  }

  /** Waits for running tasks; used on shutdown and in tests. */
  async drain(): Promise<void> {
    while (this.running > 0 || this.queue.length > 0) await new Promise((r) => setTimeout(r, 50));
  }

  private pump(): void {
    while (this.running < this.opts.maxConcurrentTasks && this.queue.length > 0) {
      const id = this.queue.shift()!;
      this.running++;
      void this.execute(id).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private async execute(taskId: string): Promise<void> {
    const task = this.get(taskId);
    if (!task || task.status !== 'QUEUED') return;
    const active: Active = { cancelled: false, timedOut: false };
    this.active.set(taskId, active);
    let configured: number | undefined;
    try {
      configured = loadConfig(task.input.projectRoot).taskTimeoutMinutes;
    } catch {
      /* the pipeline reports config errors */
    }
    const timeoutMin = task.input.timeoutMinutes ?? configured ?? this.opts.defaultTaskTimeoutMinutes ?? 45;
    active.timer = setTimeout(() => {
      active.timedOut = true;
      this.opts.registry.cancel(taskId);
    }, timeoutMin * 60_000);

    const resumeSessionId = task.input.continueFrom ? this.opts.store.getLogs(task.input.continueFrom).agentSessionId : undefined;
    let outcome: PipelineOutcome;
    try {
      this.opts.store.update(taskId, { startedAt: new Date().toISOString() });
      outcome = await runTestsPipeline(
        {
          task,
          workspaceRoot: this.opts.workspaceRoot,
          scratchDir: path.join(this.opts.workspaceRoot, `${taskId}.scratch`),
          resumeSessionId,
          setStatus: (s) => {
            const cur = this.get(taskId)!.status;
            if (cur !== s) this.transition(taskId, s);
          },
          setPhase: (phase: TaskPhase, progress: string) => {
            this.opts.activity?.append(taskId, { kind: 'phase', phase, text: progress });
            this.update(taskId, { phase, progress });
          },
          recordEvent: (event) => this.recordEvent(taskId, event),
          setPid: (pid) => this.opts.store.update(taskId, { pid }),
          setWorkspace: (p) => this.opts.store.update(taskId, { workspacePath: p }),
          saveFiles: (files) => this.opts.store.replaceFiles(taskId, files),
          saveLogs: (logs) => this.opts.store.update(taskId, { logs }),
          claimApply: () => this.opts.store.markApplied(taskId),
          releaseApply: () => this.opts.store.clearApplied(taskId),
          isCancelled: () => active.cancelled || this.opts.registry.isCancelled(taskId),
          isTimedOut: () => active.timedOut
        },
        this.opts.pipeline
      );
    } catch (err) {
      outcome = { status: 'FAILED', result: undefined as never, error: `Internal error: ${(err as Error).message}` };
    } finally {
      clearTimeout(active.timer);
      this.active.delete(taskId);
      this.opts.registry.forget(taskId);
      rmSync(path.join(this.opts.workspaceRoot, `${taskId}.scratch`), { recursive: true, force: true });
    }
    // A cancel/timeout that landed mid-step wins over whatever the step reported.
    if (active.timedOut && outcome.status !== 'TIMED_OUT' && outcome.status !== 'COMPLETED') outcome = { ...outcome, status: 'TIMED_OUT', error: 'Task time limit reached' };
    else if (active.cancelled && outcome.status !== 'CANCELLED' && outcome.status !== 'COMPLETED') outcome = { ...outcome, status: 'CANCELLED' };
    this.finish(taskId, outcome);
  }

  /** Logs an agent step, and makes the visible ones the task's progress line. */
  private recordEvent(taskId: string, event: AgentEvent): void {
    this.opts.activity?.append(taskId, event);
    const progress =
      event.kind === 'message'
        ? `agent: ${event.text!.replace(/\s+/g, ' ').slice(0, 160)}`
        : event.state === 'ACTIVE' && event.detail
          ? `agent: ${event.action ?? event.tool} ${event.detail}`
          : undefined;
    if (progress) this.update(taskId, { progress });
  }

  private finish(taskId: string, outcome: Pick<PipelineOutcome, 'status' | 'error'> & { result?: PipelineOutcome['result'] }): void {
    const result = outcome.result ? { ...outcome.result, status: outcome.status } : undefined;
    this.opts.activity?.append(taskId, { kind: 'done', status: outcome.status, text: result?.summary ?? outcome.error ?? outcome.status });
    this.transition(taskId, outcome.status, {
      phase: 'done',
      progress: result?.summary ?? outcome.error ?? outcome.status,
      finishedAt: new Date().toISOString(),
      pid: null,
      ...(result ? { result } : {}),
      ...(outcome.error ? { error: outcome.error } : {})
    });
  }

  private transition(taskId: string, to: TaskStatus, extra: Parameters<TaskStore['update']>[1] = {}): void {
    const cur = this.get(taskId);
    if (!cur) throw new Error(`Unknown task ${taskId}`);
    assertTransition(cur.status, to);
    this.update(taskId, { ...extra, status: to });
  }

  private update(taskId: string, patch: Parameters<TaskStore['update']>[1]): void {
    this.opts.store.update(taskId, patch);
    this.events.emit('change', taskId);
  }
}

/** Same request against the same checkout state => same key. */
async function fingerprint(input: DelegateInput): Promise<string> {
  const base = await captureBaseline(input.projectRoot).catch(() => undefined);
  const h = createHash('sha256');
  h.update(
    JSON.stringify({
      root: input.projectRoot.toLowerCase(),
      type: input.taskType,
      objective: input.objective.trim(),
      targets: [...input.targetPaths].sort(),
      module: input.module ?? '',
      continueFrom: input.continueFrom ?? ''
    })
  );
  h.update(base?.head ?? '');
  h.update(base?.trackedDiff ?? '');
  h.update((base?.untracked ?? []).join('\0'));
  return h.digest('hex').slice(0, 32);
}
