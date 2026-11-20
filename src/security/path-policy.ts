import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';

export interface PathDecision {
  allowed: boolean;
  reason?: string;
}

export interface PathPolicyOptions {
  writeGlobs: string[];
  protectedGlobs: string[];
  allowSymlinks: boolean;
}

/**
 * Decides whether a changed path may be written by the agent.
 * Paths are always repo-relative with forward slashes.
 */
export class PathPolicy {
  private readonly isWritable: picomatch.Matcher;
  private readonly isProtected: picomatch.Matcher;

  constructor(private readonly opts: PathPolicyOptions) {
    const mo = { dot: true, nocase: process.platform === 'win32' };
    this.isWritable = picomatch(opts.writeGlobs, mo);
    this.isProtected = picomatch(opts.protectedGlobs, mo);
  }

  /** Pure check on the path string (no filesystem access). */
  check(relPath: string): PathDecision {
    const norm = normalizeRelative(relPath);
    if (norm === undefined) return { allowed: false, reason: 'path escapes the workspace' };
    if (this.isProtected(norm)) return { allowed: false, reason: 'protected path' };
    if (!this.isWritable(norm)) return { allowed: false, reason: 'outside write_globs' };
    return { allowed: true };
  }

  /** Full check including symlink policy, against a concrete root directory. */
  checkOnDisk(root: string, relPath: string): PathDecision {
    const decision = this.check(relPath);
    if (!decision.allowed) return decision;
    const abs = path.resolve(root, relPath);
    let realRoot: string;
    try {
      realRoot = realpathSync(root);
    } catch {
      return { allowed: false, reason: 'workspace root missing' };
    }
    // Walk every existing component: a symlinked parent could redirect writes elsewhere.
    const parts = normalizeRelative(relPath)!.split('/');
    let current = root;
    for (const part of parts) {
      current = path.join(current, part);
      let st;
      try {
        st = lstatSync(current);
      } catch {
        break; // deleted or not yet created: nothing on disk to follow
      }
      if (st.isSymbolicLink()) {
        if (!this.opts.allowSymlinks) return { allowed: false, reason: 'symlink not allowed' };
        try {
          const target = realpathSync(current);
          if (!isInside(realRoot, target)) return { allowed: false, reason: 'symlink points outside the workspace' };
        } catch {
          return { allowed: false, reason: 'dangling symlink' };
        }
      }
    }
    if (!isInside(path.resolve(root), abs)) return { allowed: false, reason: 'path escapes the workspace' };
    return { allowed: true };
  }
}

/** Returns a clean forward-slash relative path, or undefined if it escapes its root. */
export function normalizeRelative(p: string): string | undefined {
  if (!p || p.includes('\0')) return undefined;
  const slashed = p.replace(/\\/g, '/');
  if (slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed)) return undefined;
  const norm = path.posix.normalize(slashed);
  if (norm === '..' || norm.startsWith('../') || norm === '.') return undefined;
  return norm.replace(/^\.\//, '');
}

export function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
