import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CompactResult, DelegateInput, TaskPhase, TaskRecord, TaskStatus } from '../types.js';

export interface StoredFileDiff {
  path: string;
  change: string;
  allowed: boolean;
  diff: string;
}

export interface StoredLogs {
  testOutput?: string;
  buildOutput?: string;
  agentResponse?: string;
  agentSessionId?: string;
}

interface TaskRow {
  id: string;
  status: string;
  phase: string;
  task_type: string;
  input: string;
  idempotency_key: string;
  progress: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  pid: number | null;
  workspace_path: string | null;
  error: string | null;
  result: string | null;
  applied_at: string | null;
  logs: string | null;
}

/**
 * Persistent task storage on SQLite (node:sqlite, no native addon).
 * All writes are synchronous so state survives a crash right after a call.
 */
export class TaskStore {
  private readonly db: DatabaseSync;

  constructor(dbFile: string) {
    if (dbFile !== ':memory:') mkdirSync(path.dirname(dbFile), { recursive: true });
    this.db = new DatabaseSync(dbFile);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        phase TEXT NOT NULL,
        task_type TEXT NOT NULL,
        input TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        progress TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        pid INTEGER,
        workspace_path TEXT,
        error TEXT,
        result TEXT,
        applied_at TEXT,
        logs TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_key ON tasks(idempotency_key);
      CREATE TABLE IF NOT EXISTS task_files (
        task_id TEXT NOT NULL,
        path TEXT NOT NULL,
        change TEXT NOT NULL,
        allowed INTEGER NOT NULL,
        diff TEXT NOT NULL,
        PRIMARY KEY (task_id, path)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  insert(task: TaskRecord): void {
    this.db
      .prepare(
        `INSERT INTO tasks (id, status, phase, task_type, input, idempotency_key, progress, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        task.id,
        task.status,
        task.phase,
        task.taskType,
        JSON.stringify(task.input),
        task.idempotencyKey,
        task.progress,
        task.createdAt,
        task.updatedAt
      );
  }

  get(id: string): TaskRecord | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  findByIdempotencyKey(key: string): TaskRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM tasks WHERE idempotency_key = ? ORDER BY created_at DESC')
      .all(key) as unknown as TaskRow[];
    return rows.map(toRecord);
  }

  listByStatus(statuses: TaskStatus[]): TaskRecord[] {
    const marks = statuses.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM tasks WHERE status IN (${marks}) ORDER BY created_at`)
      .all(...statuses) as unknown as TaskRow[];
    return rows.map(toRecord);
  }

  update(
    id: string,
    patch: Partial<{
      status: TaskStatus;
      phase: TaskPhase;
      progress: string;
      startedAt: string;
      finishedAt: string;
      pid: number | null;
      workspacePath: string | null;
      error: string | null;
      result: CompactResult;
      appliedAt: string;
      logs: StoredLogs;
    }>
  ): void {
    const columns: Record<string, string> = {
      status: 'status',
      phase: 'phase',
      progress: 'progress',
      startedAt: 'started_at',
      finishedAt: 'finished_at',
      pid: 'pid',
      workspacePath: 'workspace_path',
      error: 'error',
      result: 'result',
      appliedAt: 'applied_at',
      logs: 'logs'
    };
    const sets: string[] = ['updated_at = ?'];
    const values: Array<string | number | null> = [new Date().toISOString()];
    for (const [key, value] of Object.entries(patch)) {
      const column = columns[key];
      if (!column || value === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(typeof value === 'object' && value !== null ? JSON.stringify(value) : (value as string | number | null));
    }
    values.push(id);
    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  /** Compare-and-set used to make "apply" idempotent across concurrent callers. */
  markApplied(id: string): boolean {
    const now = new Date().toISOString();
    const res = this.db
      .prepare('UPDATE tasks SET applied_at = ?, updated_at = ? WHERE id = ? AND applied_at IS NULL')
      .run(now, now, id);
    return Number(res.changes) === 1;
  }

  clearApplied(id: string): void {
    this.db.prepare('UPDATE tasks SET applied_at = NULL WHERE id = ?').run(id);
  }

  getLogs(id: string): StoredLogs {
    const row = this.db.prepare('SELECT logs FROM tasks WHERE id = ?').get(id) as { logs: string | null } | undefined;
    return row?.logs ? (JSON.parse(row.logs) as StoredLogs) : {};
  }

  replaceFiles(taskId: string, files: StoredFileDiff[]): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM task_files WHERE task_id = ?').run(taskId);
      const insert = this.db.prepare(
        'INSERT INTO task_files (task_id, path, change, allowed, diff) VALUES (?, ?, ?, ?, ?)'
      );
      for (const f of files) insert.run(taskId, f.path, f.change, f.allowed ? 1 : 0, f.diff);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getFiles(taskId: string): StoredFileDiff[] {
    const rows = this.db
      .prepare('SELECT path, change, allowed, diff FROM task_files WHERE task_id = ? ORDER BY path')
      .all(taskId) as Array<{ path: string; change: string; allowed: number; diff: string }>;
    return rows.map((r) => ({ path: r.path, change: r.change, allowed: r.allowed === 1, diff: r.diff }));
  }
}

function toRecord(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    status: row.status as TaskStatus,
    phase: row.phase as TaskPhase,
    taskType: row.task_type as TaskRecord['taskType'],
    input: JSON.parse(row.input) as DelegateInput,
    idempotencyKey: row.idempotency_key,
    progress: row.progress,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    pid: row.pid ?? undefined,
    workspacePath: row.workspace_path ?? undefined,
    error: row.error ?? undefined,
    result: row.result ? (JSON.parse(row.result) as CompactResult) : undefined,
    appliedAt: row.applied_at ?? undefined
  };
}
