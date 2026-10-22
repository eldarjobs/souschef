import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import type { Redactor } from '../security/redact.js';
import type { ResolvedCommand } from '../security/command-policy.js';
import type { CommandOutcome } from '../types.js';

export interface RunOptions {
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  /** Owner task: lets cancel_task stop exactly the processes this task started. */
  taskId?: string;
  onSpawn?: (pid: number) => void;
}

/**
 * Keeps the head and tail of a stream; the middle is dropped once the limit is hit.
 * Test failures usually show up at the end, setup errors at the start.
 */
class BoundedBuffer {
  private head = '';
  private tail = '';
  private dropped = 0;

  constructor(private readonly limit: number) {}

  push(chunk: string): void {
    const half = Math.floor(this.limit / 2);
    if (this.head.length < half) {
      const take = chunk.slice(0, half - this.head.length);
      this.head += take;
      chunk = chunk.slice(take.length);
    }
    if (!chunk) return;
    this.tail += chunk;
    if (this.tail.length > half) {
      this.dropped += this.tail.length - half;
      this.tail = this.tail.slice(this.tail.length - half);
    }
  }

  get truncated(): boolean {
    return this.dropped > 0;
  }

  toString(): string {
    return this.dropped > 0 ? `${this.head}\n... [${this.dropped} chars omitted] ...\n${this.tail}` : this.head + this.tail;
  }
}

/** Tracks every child process SousChef starts, per task. */
export class ProcessRegistry {
  private readonly byTask = new Map<string, Set<ChildProcess>>();
  private readonly cancelled = new Set<string>();

  add(taskId: string, child: ChildProcess): void {
    let set = this.byTask.get(taskId);
    if (!set) this.byTask.set(taskId, (set = new Set()));
    set.add(child);
    child.once('exit', () => set.delete(child));
  }

  isCancelled(taskId: string): boolean {
    return this.cancelled.has(taskId);
  }

  /** Kills only the process trees this registry spawned for the task. */
  cancel(taskId: string): number {
    this.cancelled.add(taskId);
    const set = this.byTask.get(taskId);
    if (!set) return 0;
    let killed = 0;
    for (const child of set) {
      if (child.pid && child.exitCode === null) {
        killTree(child);
        killed++;
      }
    }
    return killed;
  }

  forget(taskId: string): void {
    this.byTask.delete(taskId);
    this.cancelled.delete(taskId);
  }
}

export function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
    setTimeout(() => {
      try {
        if (child.exitCode === null) process.kill(-child.pid!, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }, 3000).unref();
  }
}

function quoteForCmd(arg: string): string {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

export class ProcessRunner {
  constructor(
    private readonly registry: ProcessRegistry,
    private readonly redactor: Redactor
  ) {}

  run(command: ResolvedCommand, opts: RunOptions): Promise<CommandOutcome> {
    const started = Date.now();
    return new Promise((resolve) => {
      if (opts.taskId && this.registry.isCancelled(opts.taskId)) {
        resolve({ exitCode: null, signal: null, timedOut: false, cancelled: true, durationMs: 0, output: '', truncated: false });
        return;
      }
      // Windows .cmd shims cannot be spawned without cmd.exe; their arguments were
      // already restricted to a safe character set by CommandPolicy.
      const child = command.viaShell
        ? // With /s, cmd strips one pair of outer quotes, so the whole line is wrapped once more.
        spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${[command.file, ...command.args].map(quoteForCmd).join(' ')}"`], {
            cwd: opts.cwd,
            env: opts.env ?? process.env,
            windowsHide: true,
            windowsVerbatimArguments: true,
            stdio: ['pipe', 'pipe', 'pipe']
          })
        : spawn(command.file, command.args, {
            cwd: opts.cwd,
            env: opts.env ?? process.env,
            windowsHide: true,
            detached: process.platform !== 'win32',
            stdio: ['pipe', 'pipe', 'pipe']
          });

      const buffer = new BoundedBuffer(opts.maxOutputBytes);
      let timedOut = false;
      let settled = false;

      if (opts.taskId) this.registry.add(opts.taskId, child);
      if (child.pid && opts.onSpawn) opts.onSpawn(child.pid);

      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, opts.timeoutMs);

      child.stdout?.setEncoding('utf8').on('data', (c: string) => buffer.push(c));
      child.stderr?.setEncoding('utf8').on('data', (c: string) => buffer.push(c));
      if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
      else child.stdin?.end();

      const finish = (exitCode: number | null, signal: string | null, extra = '') => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (extra) buffer.push(extra);
        resolve({
          exitCode,
          signal,
          timedOut,
          cancelled: opts.taskId ? this.registry.isCancelled(opts.taskId) : false,
          durationMs: Date.now() - started,
          output: this.redactor.redact(buffer.toString()),
          truncated: buffer.truncated
        });
      };
      child.once('error', (err) => finish(null, null, `\n[spawn error] ${err.message}`));
      child.once('close', (code, signal) => finish(code, signal));
    });
  }
}
