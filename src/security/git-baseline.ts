import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

let hooksDir: string | undefined;
function emptyHooksDir(): string {
  if (!hooksDir) {
    hooksDir = path.join(tmpdir(), 'souschef-no-hooks');
    mkdirSync(hooksDir, { recursive: true });
  }
  return hooksDir.replace(/\\/g, '/');
}

export interface GitOptions {
  cwd: string;
  /** Extra `-c key=value` settings, e.g. a workspace-only excludes file. */
  config?: Record<string, string>;
  input?: string;
}

/** Runs git without a shell and returns stdout. Throws with stderr on failure. */
export async function git(args: string[], opts: GitOptions): Promise<string> {
  const cfg = Object.entries(opts.config ?? {}).flatMap(([k, v]) => ['-c', `${k}=${v}`]);
  // Repository hooks (e.g. post-checkout on `worktree add`) and fsmonitor never run
  // inside souschef-driven git commands: hooksPath points at an empty directory.
  const base = ['-c', `core.hooksPath=${emptyHooksDir()}`, '-c', 'core.fsmonitor=false'];
  if (opts.input !== undefined) {
    return new Promise((resolve, reject) => {
      const child = execFile('git', [...base, ...cfg, ...args], { cwd: opts.cwd, maxBuffer: 512 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        if (err) reject(new Error(`git ${args[0]} failed: ${stderr || err.message}`));
        else resolve(stdout);
      });
      child.stdin?.end(opts.input);
    });
  }
  try {
    const { stdout } = await execFileAsync('git', [...base, ...cfg, ...args], {
      cwd: opts.cwd,
      maxBuffer: 512 * 1024 * 1024,
      windowsHide: true
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new Error(`git ${args[0]} failed: ${e.stderr || e.message}`);
  }
}

export async function gitBuffer(args: string[], cwd: string): Promise<Buffer> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'buffer',
    maxBuffer: 512 * 1024 * 1024,
    windowsHide: true
  });
  return stdout;
}

export interface GitBaseline {
  isRepo: boolean;
  topLevel?: string;
  head?: string;
  /** Binary diff of tracked changes (staged + unstaged) relative to HEAD. */
  trackedDiff?: string;
  /** Tracked paths whose working-tree content differs from HEAD. */
  trackedChanges: NameStatus[];
  /** Untracked, non-ignored files (relative to topLevel). */
  untracked: string[];
  dirty: boolean;
}

/** Records the user's checkout state without modifying it. */
export async function captureBaseline(projectRoot: string): Promise<GitBaseline> {
  let topLevel: string;
  try {
    topLevel = (await git(['rev-parse', '--show-toplevel'], { cwd: projectRoot })).trim();
  } catch {
    return { isRepo: false, trackedChanges: [], untracked: [], dirty: false };
  }
  let head: string | undefined;
  try {
    head = (await git(['rev-parse', '--verify', 'HEAD'], { cwd: topLevel })).trim();
  } catch {
    // Unborn branch: no commit to build a worktree from.
    return { isRepo: true, topLevel, trackedChanges: [], untracked: [], dirty: true };
  }
  const trackedDiff = await git(['diff', '--binary', '--no-color', '--no-ext-diff', 'HEAD'], { cwd: topLevel });
  const trackedChanges = parseNameStatusZ(await git(['diff', '--name-status', '--no-renames', '-z', 'HEAD'], { cwd: topLevel }));
  const untracked = (await git(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: topLevel }))
    .split('\0')
    .filter(Boolean);
  return { isRepo: true, topLevel, head, trackedDiff, trackedChanges, untracked, dirty: trackedChanges.length > 0 || untracked.length > 0 };
}

export interface NameStatus {
  change: string;
  path: string;
}

export function parseNameStatusZ(out: string): NameStatus[] {
  const parts = out.split('\0').filter((p) => p.length > 0);
  const result: NameStatus[] = [];
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++]!;
    const letter = status[0]!;
    if (letter === 'R' || letter === 'C') {
      const from = parts[i++]!;
      const to = parts[i++]!;
      // A rename touches both paths; both must pass the path policy.
      result.push({ change: 'D', path: from }, { change: 'A', path: to });
    } else {
      result.push({ change: letter, path: parts[i++]! });
    }
  }
  return result;
}
