import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';
import { captureBaseline, git, gitBuffer, parseNameStatusZ, type GitBaseline, type NameStatus } from '../security/git-baseline.js';

/** Build outputs never count as agent changes. */
const DEFAULT_EXCLUDES = [
  'bin/',
  'obj/',
  'target/',
  'node_modules/',
  '.venv/',
  'venv/',
  '__pycache__/',
  '*.pyc',
  '.pytest_cache/',
  'TestResults/',
  'coverage/',
  '.nyc_output/'
];

export interface Workspace {
  taskId: string;
  mode: 'git-worktree' | 'copy';
  /** Directory the agent and the test runner work in. */
  root: string;
  /** The directory in the user's checkout that `root` mirrors. */
  mainRoot: string;
  /** Project root relative to `root` (forward slashes, '' when equal). */
  projectSubdir: string;
  baselineTree: string;
  baseline: GitBaseline;
  gitConfig: Record<string, string>;
  links: string[];
}

export interface PrepareOptions {
  taskId: string;
  projectRoot: string;
  workspaceRoot: string;
  linkDirs: string[];
  copyExclude: string[];
}

export class WorkspaceManager {
  async prepare(opts: PrepareOptions): Promise<Workspace> {
    const baseline = await captureBaseline(opts.projectRoot);
    const dir = path.join(opts.workspaceRoot, opts.taskId);
    mkdirSync(opts.workspaceRoot, { recursive: true });
    if (existsSync(dir)) throw new Error(`Workspace ${dir} already exists`);

    const excludesFile = path.join(opts.workspaceRoot, `${opts.taskId}.exclude`);
    writeFileSync(excludesFile, [...DEFAULT_EXCLUDES, ...opts.linkDirs.map((d) => `${d}/`)].join('\n') + '\n');
    const gitConfig = { 'core.excludesFile': excludesFile.replace(/\\/g, '/'), 'core.autocrlf': 'false' };

    let ws: Workspace;
    if (baseline.isRepo && baseline.head && baseline.topLevel) {
      const mainRoot = realpathSync.native(baseline.topLevel);
      await git(['worktree', 'add', '--detach', '--quiet', dir, baseline.head], { cwd: mainRoot });
      ws = {
        taskId: opts.taskId,
        mode: 'git-worktree',
        root: dir,
        mainRoot,
        projectSubdir: toPosix(path.relative(realpathSync.native(mainRoot), realpathSync.native(opts.projectRoot))),
        baselineTree: '',
        baseline,
        gitConfig,
        links: []
      };
      try {
        // Uncommitted work is part of what the agent must test against. Files are copied
        // byte for byte rather than patched, so line-ending settings cannot break it.
        for (const { change, path: rel } of baseline.trackedChanges) {
          const to = path.join(dir, rel);
          if (change === 'D') {
            rmSync(to, { force: true });
            continue;
          }
          mkdirSync(path.dirname(to), { recursive: true });
          cpSync(path.join(mainRoot, rel), to, { verbatimSymlinks: true, force: true });
        }
        for (const rel of baseline.untracked) {
          const from = path.join(mainRoot, rel);
          const to = path.join(dir, rel);
          mkdirSync(path.dirname(to), { recursive: true });
          cpSync(from, to, { verbatimSymlinks: true, force: true });
        }
      } catch (err) {
        await this.cleanup(ws);
        throw err;
      }
    } else {
      const mainRoot = path.resolve(opts.projectRoot);
      const exclude = new Set(opts.copyExclude);
      cpSync(mainRoot, dir, {
        recursive: true,
        verbatimSymlinks: true,
        filter: (src) => src === mainRoot || !exclude.has(path.basename(src))
      });
      await git(['init', '--quiet'], { cwd: dir });
      ws = { taskId: opts.taskId, mode: 'copy', root: dir, mainRoot, projectSubdir: '', baselineTree: '', baseline, gitConfig, links: [] };
    }

    try {
      ws.links = linkDependencyDirs(ws.mainRoot, ws.root, opts.linkDirs);
      await git(['add', '-A'], { cwd: ws.root, config: gitConfig });
      ws.baselineTree = (await git(['write-tree'], { cwd: ws.root, config: gitConfig })).trim();
    } catch (err) {
      await this.cleanup(ws);
      throw err;
    }
    return ws;
  }

  /** Every path that differs from the baseline snapshot, including untracked files. */
  async changes(ws: Workspace): Promise<NameStatus[]> {
    await git(['add', '-A'], { cwd: ws.root, config: ws.gitConfig });
    const out = await git(['diff', '--cached', '--name-status', '--no-renames', '-z', ws.baselineTree], {
      cwd: ws.root,
      config: ws.gitConfig
    });
    return parseNameStatusZ(out);
  }

  async fileDiff(ws: Workspace, relPath: string): Promise<string> {
    return git(['diff', '--cached', '--no-color', '--no-ext-diff', ws.baselineTree, '--', relPath], {
      cwd: ws.root,
      config: ws.gitConfig
    });
  }

  async baselineContent(ws: Workspace, relPath: string): Promise<Buffer | undefined> {
    try {
      return await gitBuffer(['cat-file', 'blob', `${ws.baselineTree}:${relPath}`], ws.root);
    } catch {
      return undefined;
    }
  }

  readWorkspaceFile(ws: Workspace, relPath: string): Buffer {
    return readFileSync(path.join(ws.root, relPath));
  }

  async cleanup(ws: Workspace): Promise<void> {
    // Remove dependency links first so no recursive delete can follow them into
    // the user's real node_modules / virtualenv.
    for (const link of ws.links) removeLink(link);
    ws.links = [];
    if (ws.mode === 'git-worktree') {
      try {
        await git(['worktree', 'remove', '--force', ws.root], { cwd: ws.mainRoot });
      } catch {
        /* fall through to manual removal */
      }
    }
    if (existsSync(ws.root)) rmSync(ws.root, { recursive: true, force: true, maxRetries: 3 });
    if (ws.mode === 'git-worktree') await git(['worktree', 'prune'], { cwd: ws.mainRoot }).catch(() => undefined);
    rmSync(path.join(path.dirname(ws.root), `${ws.taskId}.exclude`), { force: true });
  }
}

/** Links dependency directories found in the main checkout (up to 3 levels deep). */
function linkDependencyDirs(mainRoot: string, wsRoot: string, names: string[]): string[] {
  if (names.length === 0) return [];
  const wanted = new Set(names);
  const skip = new Set(['.git', ...names, 'bin', 'obj', 'target', 'dist', 'build']);
  const links: string[] = [];
  const walk = (rel: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(path.join(mainRoot, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const childRel = rel ? path.join(rel, e.name) : e.name;
      if (wanted.has(e.name)) {
        const target = path.join(mainRoot, childRel);
        const link = path.join(wsRoot, childRel);
        if (!existsSync(path.dirname(link)) || existsSync(link)) continue;
        symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
        links.push(link);
      } else if (depth < 3 && !skip.has(e.name) && !e.name.startsWith('.')) {
        walk(childRel, depth + 1);
      }
    }
  };
  walk('', 0);
  return links;
}

function removeLink(link: string): void {
  try {
    if (lstatSync(link).isSymbolicLink()) unlinkSync(link);
  } catch {
    /* already gone */
  }
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}
