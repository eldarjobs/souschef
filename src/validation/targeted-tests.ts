import { readdirSync } from 'node:fs';
import path from 'node:path';
import type { CommandSpec } from '../types.js';

const SOURCE = /\.(cs|fs|vb)$/i;
const PROJECT = /\.(cs|fs|vb)proj$/i;

/**
 * Turns `dotnet test <solution> ...` into one `dotnet test <project> --filter <classes>` per test
 * project the agent touched, so three new tests do not build and run a whole solution.
 * The original arguments (artifacts path, properties, an existing filter) are kept.
 * Returns undefined when the command is not `dotnet test` or a changed file has no project,
 * in which case the full command runs.
 *
 * @param changedFiles paths relative to `root` (the workspace)
 * @param cwd the command's working directory relative to `root`
 */
export function narrowDotnetTest(test: CommandSpec, changedFiles: string[], root: string, cwd: string): CommandSpec[] | undefined {
  const exe = path.basename(test.executable).replace(/\.exe$/i, '').toLowerCase();
  if (exe !== 'dotnet' || test.args[0] !== 'test') return undefined;
  const sources = changedFiles.filter((f) => SOURCE.test(f));
  if (sources.length === 0) return undefined;

  const byProject = new Map<string, Set<string>>();
  for (const file of sources) {
    const project = owningProject(root, file);
    if (!project) return undefined;
    let classes = byProject.get(project);
    if (!classes) byProject.set(project, (classes = new Set()));
    classes.add(path.basename(file).replace(SOURCE, ''));
  }

  const { rest, filter } = splitArgs(test.args.slice(1));
  const cwdAbs = path.resolve(root, cwd);
  return [...byProject].map(([project, classes]) => {
    const own = [...classes].map((c) => `FullyQualifiedName~${c}`).join('|');
    const combined = filter ? `(${filter})&(${own})` : own;
    const rel = path.relative(cwdAbs, path.resolve(root, project)).split(path.sep).join('/');
    return { ...test, args: ['test', rel, ...rest, '--filter', combined] };
  });
}

/** Drops the solution/project positional and --no-build; pulls out --filter. */
function splitArgs(args: string[]): { rest: string[]; filter?: string } {
  const rest: string[] = [];
  let filter: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (i === 0 && !a.startsWith('-')) continue;
    if (a === '--no-build') continue;
    if (a === '--filter') {
      filter = args[++i];
      continue;
    }
    if (a.startsWith('--filter=')) {
      filter = a.slice('--filter='.length);
      continue;
    }
    rest.push(a);
  }
  return { rest, filter };
}

/** Nearest *.csproj/fsproj/vbproj walking up from the file, relative to root. */
function owningProject(root: string, file: string): string | undefined {
  let dir = path.posix.dirname(file);
  for (;;) {
    let entries: string[] = [];
    try {
      entries = readdirSync(path.join(root, dir));
    } catch {
      /* directory may not exist for deleted files */
    }
    const projects = entries.filter((e) => PROJECT.test(e));
    if (projects.length === 1) return dir === '.' ? projects[0] : `${dir}/${projects[0]}`;
    if (projects.length > 1) return undefined;
    if (dir === '.' || dir === '') return undefined;
    dir = path.posix.dirname(dir);
  }
}
