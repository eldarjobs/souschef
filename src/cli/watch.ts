import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import { formatEntry, HeadlineFilter, latestTaskId, parseEntry } from '../reporting/activity-log.js';

export interface WatchOptions {
  pollMs?: number;
  /** How long to wait for a task's activity file to appear. */
  waitForFileMs?: number;
  write?: (text: string) => void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `souschef watch [taskId]`: follows a task's activity file and prints each step as it
 * happens, until the task is done. Without an id it follows the most recent task.
 * Stopping the watch (Ctrl+C) leaves the task running.
 */
export async function watchTask(arg: string | undefined, eventsDir: string, opts: WatchOptions = {}): Promise<number> {
  const write = opts.write ?? ((text: string) => void process.stdout.write(text));
  const pollMs = opts.pollMs ?? 500;
  const taskId = arg && arg !== '--latest' ? arg : latestTaskId(eventsDir);
  if (!taskId) {
    write('souschef watch: no tasks yet.\n');
    return 1;
  }

  const file = path.join(eventsDir, `${taskId}.ndjson`);
  write(`souschef watch ${taskId}  (Ctrl+C stops watching; the task keeps running)\n\n`);
  const deadline = Date.now() + (opts.waitForFileMs ?? 30_000);
  while (!existsSync(file)) {
    if (Date.now() > deadline) {
      write(`No activity for ${taskId} in ${eventsDir}.\n`);
      return 1;
    }
    await sleep(pollMs);
  }

  const headlines = new HeadlineFilter();
  let offset = 0;
  let partial = '';
  for (;;) {
    const size = statSync(file).size;
    if (size > offset) {
      const fd = openSync(file, 'r');
      const chunk = Buffer.alloc(size - offset);
      try {
        readSync(fd, chunk, 0, chunk.length, offset);
      } finally {
        closeSync(fd);
      }
      offset = size;
      const lines = (partial + chunk.toString('utf8')).split('\n');
      partial = lines.pop()!;
      for (const line of lines) {
        const entry = parseEntry(line);
        const shown = entry && headlines.accept(entry);
        if (!shown) continue;
        write(formatEntry(shown) + '\n');
        if (shown.kind === 'done') return 0;
      }
    }
    await sleep(pollMs);
  }
}
