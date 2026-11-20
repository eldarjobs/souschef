import { existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { NameStatus } from '../security/git-baseline.js';
import type { PathPolicy } from '../security/path-policy.js';
import type { ChangedFile } from '../types.js';
import type { Workspace, WorkspaceManager } from '../workspace/workspace-manager.js';

export interface ScopeReport {
  files: ChangedFile[];
  violations: ChangedFile[];
  /** Existing test files the agent edited (possible assertion weakening; surfaced, not blocked). */
  modifiedExisting: string[];
}

/** Applies write_globs, protected paths, symlink and deletion rules to every changed path. */
export function checkScope(ws: Workspace, changes: NameStatus[], policy: PathPolicy, allowDeletions: boolean): ScopeReport {
  const files: ChangedFile[] = changes.map(({ change, path: p }) => {
    let decision = policy.checkOnDisk(ws.root, p);
    if (decision.allowed && change === 'D' && !allowDeletions) decision = { allowed: false, reason: 'deletion not allowed' };
    if (decision.allowed && change === 'T') decision = { allowed: false, reason: 'file type change not allowed' };
    return { path: p, change, allowed: decision.allowed, reason: decision.reason };
  });
  return {
    files,
    violations: files.filter((f) => !f.allowed),
    modifiedExisting: files.filter((f) => f.allowed && f.change === 'M').map((f) => f.path)
  };
}

/**
 * The user's checkout may have moved on while the agent worked. A path conflicts
 * when its current content in the main checkout differs from the snapshot the
 * agent started from.
 */
export async function findConflicts(ws: Workspace, manager: WorkspaceManager, files: ChangedFile[], policy: PathPolicy): Promise<string[]> {
  const conflicts: string[] = [];
  for (const f of files) {
    const mainPath = path.join(ws.mainRoot, f.path);
    const onDisk = policy.checkOnDisk(ws.mainRoot, f.path);
    if (!onDisk.allowed && onDisk.reason !== 'outside write_globs') {
      conflicts.push(`${f.path} (${onDisk.reason})`);
      continue;
    }
    const base = await manager.baselineContent(ws, f.path);
    const current = readIfFile(mainPath);
    if (current === 'not-a-file') {
      conflicts.push(`${f.path} (not a regular file in the checkout)`);
      continue;
    }
    const same = base === undefined ? current === undefined : current !== undefined && base.equals(current);
    if (same) continue;
    // Already identical to the agent's result (e.g. applied before): not a conflict.
    if (f.change !== 'D' && current !== undefined && current.equals(manager.readWorkspaceFile(ws, f.path))) continue;
    if (f.change === 'D' && current === undefined) continue;
    conflicts.push(f.path);
  }
  return conflicts;
}

/** Copies verified files into the user's checkout. Never touches anything else. */
export function applyFiles(ws: Workspace, manager: WorkspaceManager, files: ChangedFile[]): string[] {
  const applied: string[] = [];
  for (const f of files) {
    const target = path.join(ws.mainRoot, f.path);
    if (f.change === 'D') {
      if (existsSync(target)) unlinkSync(target);
    } else {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, manager.readWorkspaceFile(ws, f.path));
    }
    applied.push(f.path);
  }
  return applied;
}

function readIfFile(p: string): Buffer | undefined | 'not-a-file' {
  try {
    const st = lstatSync(p);
    if (!st.isFile()) return 'not-a-file';
    return readFileSync(p);
  } catch {
    return undefined;
  }
}
