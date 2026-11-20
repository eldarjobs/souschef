import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { AgentEvent } from '../adapters/agent-adapter.js';

/** One line of a task's activity file, `<dataDir>/events/<taskId>.ndjson`. */
export interface ActivityEntry extends Omit<AgentEvent, 'kind'> {
  at: string;
  kind: AgentEvent['kind'] | 'phase' | 'done';
  phase?: string;
  status?: string;
}

/**
 * The live record of what a task is doing: SousChef phases plus every step the agent
 * takes. wait_for_task shows its tail, and `souschef watch` follows it from a terminal.
 */
export class ActivityLog {
  constructor(
    private readonly dir: string,
    private readonly redact: (text: string) => string = (t) => t
  ) {
    mkdirSync(dir, { recursive: true });
  }

  file(taskId: string): string {
    return path.join(this.dir, `${taskId}.ndjson`);
  }

  append(taskId: string, entry: Omit<ActivityEntry, 'at'>): void {
    const clean: ActivityEntry = { at: new Date().toISOString(), ...entry };
    for (const key of ['detail', 'output', 'text'] as const) {
      if (clean[key]) clean[key] = this.redact(clean[key]!);
    }
    try {
      appendFileSync(this.file(taskId), JSON.stringify(clean) + '\n');
    } catch {
      // The live view is best effort; the task itself must not fail over it.
    }
  }

  /** The latest steps worth reading, oldest first, formatted one per line. */
  recent(taskId: string, limit: number): string[] {
    const headlines = new HeadlineFilter();
    const lines: string[] = [];
    for (const entry of readEntries(this.file(taskId))) {
      const shown = headlines.accept(entry);
      if (shown) lines.push(formatEntry(shown));
    }
    return lines.slice(-limit);
  }
}

export function parseEntry(line: string): ActivityEntry | undefined {
  try {
    const value = JSON.parse(line) as ActivityEntry;
    return value && typeof value === 'object' && value.kind ? value : undefined;
  } catch {
    return undefined;
  }
}

export function readEntries(file: string): ActivityEntry[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .map(parseEntry)
    .filter((e): e is ActivityEntry => e !== undefined);
}

/** The task whose activity file changed last, for `souschef watch` without an id. */
export function latestTaskId(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  let best: { id: string; mtime: number } | undefined;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.ndjson')) continue;
    const mtime = statSync(path.join(dir, name)).mtimeMs;
    if (!best || mtime > best.mtime) best = { id: name.slice(0, -'.ndjson'.length), mtime };
  }
  return best?.id;
}

/**
 * Drops the noise from a stream of entries: a tool is shown when it starts, and its
 * end only when it says something new (a command's exit and last line, or a path the
 * start did not carry).
 */
export class HeadlineFilter {
  private lastStart?: ActivityEntry;

  accept(entry: ActivityEntry): ActivityEntry | undefined {
    if (entry.kind !== 'tool') return entry;
    if (entry.state === 'ACTIVE') {
      this.lastStart = entry;
      return entry.detail ? entry : undefined;
    }
    const start = this.lastStart;
    this.lastStart = undefined;
    if (entry.output) return entry;
    if (entry.detail && !start?.detail) return { ...entry, state: 'ACTIVE' };
    return undefined;
  }
}

/** "10:05:20  write  SkyChef/Tests/Foo.cs", in local time, plain ASCII. */
export function formatEntry(entry: ActivityEntry): string {
  const time = new Date(entry.at).toTimeString().slice(0, 8);
  switch (entry.kind) {
    case 'phase':
      return `${time}  [${entry.phase ?? 'phase'}] ${entry.text ?? ''}`.trimEnd();
    case 'done':
      return `${time}  == ${entry.status ?? 'DONE'}: ${entry.text ?? ''}`.trimEnd();
    case 'message':
      return `${time}  agent: ${oneLine(entry.text ?? '', 200)}`;
    case 'tool': {
      if (entry.state === 'DONE') {
        const took = entry.seconds !== undefined ? ` (${entry.seconds.toFixed(1)}s)` : '';
        return `${time}         -> ${entry.output ?? `${entry.action ?? entry.tool} done`}${took}`;
      }
      return `${time}  ${(entry.action ?? entry.tool ?? 'tool').padEnd(6)} ${entry.detail ?? ''}`.trimEnd();
    }
  }
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}
