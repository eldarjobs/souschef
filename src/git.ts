import { execFile } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Changed or untracked paths (relative to the project root, forward slashes) mapped to their mtime. */
export type Snapshot = Map<string, number>;

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await run("git", args, { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch {
    return undefined;
  }
}

export async function gitTopLevel(cwd: string): Promise<string | undefined> {
  const out = (await git(cwd, ["rev-parse", "--show-toplevel"]))?.trim();
  if (!out) return undefined;
  try {
    return realpathSync.native(out);
  } catch {
    return path.resolve(out);
  }
}

/**
 * Everything `git status` reports, with each file's mtime.
 *
 * A path that was already dirty before the run is caught again only if its mtime moves, so the
 * baseline taken at start keeps someone else's unrelated edits out of the run's report.
 */
export async function snapshot(projectRoot: string, top: string): Promise<Snapshot> {
  const out = await git(projectRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const files: Snapshot = new Map();
  if (out === undefined) return files;

  const entries = out.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const fromTop = entry.slice(3);
    // Renames and copies carry the old path as the next entry.
    if (status[0] === "R" || status[0] === "C") i++;

    const absolute = path.join(top, fromTop);
    const relative = path.relative(projectRoot, absolute).split(path.sep).join("/");
    let mtime = -1;
    try {
      mtime = statSync(absolute).mtimeMs;
    } catch {
      // deleted
    }
    files.set(relative, mtime);
  }
  return files;
}

/** Paths that are new since `before`, or whose mtime moved. */
export function changedSince(before: Snapshot, after: Snapshot): string[] {
  const changed: string[] = [];
  for (const [file, mtime] of after) {
    if (before.get(file) !== mtime) changed.push(file);
  }
  return changed.sort();
}
