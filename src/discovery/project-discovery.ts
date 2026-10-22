import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import type { ModuleConfig, SousChefConfig } from '../config/config-loader.js';
import { isInside, normalizeRelative } from '../security/path-policy.js';
import type { CommandSpec, DiscoveryOutcome, TestPlan } from '../types.js';

type Ecosystem = 'dotnet' | 'node' | 'python' | 'go' | 'rust';

interface Candidate {
  ecosystem: Ecosystem;
  /** Relative to projectRoot, forward slashes, '' for the root. */
  moduleRoot: string;
  test: CommandSpec;
  build?: CommandSpec;
  notes: string[];
}

interface Detection {
  candidate?: Candidate;
  problem?: string;
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'bin', 'obj', 'target', 'dist', 'build', '.venv', 'venv', '__pycache__', '.idea', '.vs']);

const EXT_TO_ECOSYSTEM: Record<string, Ecosystem> = {
  '.cs': 'dotnet',
  '.fs': 'dotnet',
  '.vb': 'dotnet',
  '.ts': 'node',
  '.tsx': 'node',
  '.js': 'node',
  '.jsx': 'node',
  '.mjs': 'node',
  '.cjs': 'node',
  '.vue': 'node',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust'
};

/**
 * Builds a test plan. Priority: .souschef.json, then manifests nearest to the
 * target files. Never guesses: anything ambiguous comes back as `problem`.
 */
export function discoverTestPlan(
  projectRoot: string,
  config: SousChefConfig,
  targetPaths: string[],
  moduleHint?: string
): DiscoveryOutcome {
  const root = path.resolve(projectRoot);
  const targets = targetPaths.map((t) => normalizeRelative(path.isAbsolute(t) ? path.relative(root, t) : t));
  if (targets.some((t) => t === undefined)) {
    return { problem: 'targetPaths must stay inside projectRoot', candidates: [] };
  }
  const relTargets = targets as string[];

  // 1. Explicit configuration.
  const fromConfig = planFromConfig(root, config, relTargets, moduleHint);
  if (fromConfig) return fromConfig;

  // 2-4. Manifests / solutions / test projects / lockfiles, nearest to the targets.
  const startDirs = moduleHint
    ? [normalizeRelative(moduleHint) ?? '']
    : relTargets.length > 0
      ? relTargets.map((t) => (isDir(path.join(root, t)) ? t : path.posix.dirname(t)).replace(/^\.$/, ''))
      : [''];

  const found = new Map<string, Candidate>();
  for (const start of startDirs) {
    const det = detectNearest(root, start, relTargets);
    if (det.problem) return { problem: det.problem, candidates: [...found.values()].map(publicCandidate) };
    if (det.candidate) found.set(`${det.candidate.ecosystem}:${det.candidate.moduleRoot}`, det.candidate);
  }

  const candidates = [...found.values()];
  if (candidates.length === 0) {
    return {
      problem:
        'No test infrastructure detected. Add a "test" command to .souschef.json (executable + args) or a test script to the project manifest.',
      candidates: []
    };
  }
  if (candidates.length > 1) {
    return {
      problem: `targetPaths span ${candidates.length} modules (${candidates
        .map((c) => `${c.ecosystem}@${c.moduleRoot || '.'}`)
        .join(', ')}). Delegate one module per task using the "module" field, or configure modules in .souschef.json.`,
      candidates: candidates.map(publicCandidate)
    };
  }
  const chosen = candidates[0]!;
  return {
    plan: {
      ecosystem: chosen.ecosystem,
      moduleRoot: chosen.moduleRoot,
      build: chosen.build,
      test: chosen.test,
      source: 'discovery',
      notes: chosen.notes,
      testExamples: findTestExamples(root, chosen.moduleRoot, config.writeGlobs, relTargets)
    },
    candidates: [publicCandidate(chosen)]
  };
}

function publicCandidate(c: Candidate) {
  return { ecosystem: c.ecosystem, moduleRoot: c.moduleRoot, test: c.test };
}

function planFromConfig(root: string, config: SousChefConfig, targets: string[], moduleHint?: string): DiscoveryOutcome | undefined {
  const pick = (m: ModuleConfig): DiscoveryOutcome | undefined => {
    if (!m.test) return undefined;
    const moduleRoot = normalizeRelative(m.root) ?? '';
    return {
      plan: {
        ecosystem: 'configured',
        moduleRoot,
        build: m.build,
        test: m.test,
        source: 'config',
        notes: [`Using module "${moduleRoot || '.'}" from .souschef.json`],
        testExamples: findTestExamples(root, moduleRoot, m.writeGlobs ?? config.writeGlobs, targets)
      },
      candidates: []
    };
  };
  if (config.modules.length > 0) {
    const hint = moduleHint ? normalizeRelative(moduleHint) : undefined;
    const byHint = hint !== undefined ? config.modules.find((m) => normalizeRelative(m.root) === hint) : undefined;
    if (byHint) return pick(byHint);
    if (targets.length > 0) {
      const owners = new Set(
        targets.map((t) =>
          config.modules
            .filter((m) => isUnder(t, normalizeRelative(m.root) ?? ''))
            .sort((a, b) => b.root.length - a.root.length)[0]
        )
      );
      if (owners.size === 1) {
        const only = [...owners][0];
        if (only) return pick(only);
      } else if (owners.size > 1) {
        return { problem: 'targetPaths belong to several configured modules; delegate one module per task.', candidates: [] };
      }
    }
  }
  if (config.test) {
    return {
      plan: {
        ecosystem: 'configured',
        moduleRoot: '',
        build: config.build,
        test: config.test,
        source: 'config',
        notes: ['Using test command from .souschef.json'],
        testExamples: findTestExamples(root, '', config.writeGlobs, targets)
      },
      candidates: []
    };
  }
  return undefined;
}

function isUnder(rel: string, dir: string): boolean {
  return dir === '' || rel === dir || rel.startsWith(dir + '/');
}

/** Walks from `start` up to the project root and returns the first directory with a manifest. */
function detectNearest(root: string, start: string, targets: string[]): Detection {
  const preferred = preferredEcosystem(targets);
  let rel = start;
  for (;;) {
    const dir = path.join(root, rel);
    const hits = detectAt(root, rel, dir).filter((d) => d.candidate || d.problem);
    if (hits.length > 0) {
      const usable = hits.filter((h) => h.candidate);
      const pick =
        (preferred && hits.find((h) => h.candidate?.ecosystem === preferred || h.problem?.startsWith(preferred))) ??
        (usable.length === 1 ? usable[0] : undefined);
      if (pick) return pick;
      if (hits.length === 1) return hits[0]!;
      return {
        problem: `Several test toolchains found in "${rel || '.'}" (${hits
          .map((h) => h.candidate?.ecosystem ?? 'unknown')
          .join(', ')}); set "test" in .souschef.json.`
      };
    }
    if (rel === '') return {};
    const parent = path.posix.dirname(rel);
    rel = parent === '.' ? '' : parent;
  }
}

function preferredEcosystem(targets: string[]): Ecosystem | undefined {
  const set = new Set(targets.map((t) => EXT_TO_ECOSYSTEM[path.extname(t).toLowerCase()]).filter(Boolean));
  return set.size === 1 ? [...set][0] : undefined;
}

function detectAt(root: string, rel: string, dir: string): Detection[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const has = (name: string) => entries.includes(name);
  const results: Detection[] = [];

  // .NET
  if (entries.some((e) => /\.(sln|slnx|csproj|fsproj|vbproj)$/i.test(e))) results.push(detectDotnet(root, rel));

  // Node
  if (has('package.json')) {
    const det = detectNode(root, rel, dir);
    if (det) results.push(det);
  }

  // Python
  const pyproject = has('pyproject.toml') ? safeRead(path.join(dir, 'pyproject.toml')) : '';
  const setupCfg = has('setup.cfg') ? safeRead(path.join(dir, 'setup.cfg')) : '';
  if (
    has('pytest.ini') ||
    has('conftest.py') ||
    pyproject.includes('[tool.pytest') ||
    setupCfg.includes('[tool:pytest]') ||
    (has('tox.ini') && safeRead(path.join(dir, 'tox.ini')).includes('[pytest]'))
  ) {
    results.push({ candidate: pythonCandidate(rel, dir, entries) });
  } else if (has('pyproject.toml') || has('setup.py')) {
    results.push({ problem: `python: "${rel || '.'}" has a Python manifest but no pytest configuration; set "test" in .souschef.json.` });
  }

  if (has('go.mod')) {
    results.push({
      candidate: { ecosystem: 'go', moduleRoot: rel, test: { executable: 'go', args: ['test', './...'], cwd: rel || '.' }, notes: [] }
    });
  }
  if (has('Cargo.toml')) {
    results.push({
      candidate: {
        ecosystem: 'rust',
        moduleRoot: rel,
        build: { executable: 'cargo', args: ['test', '--no-run'], cwd: rel || '.' },
        test: { executable: 'cargo', args: ['test'], cwd: rel || '.' },
        notes: []
      }
    });
  }
  return results;
}

function detectDotnet(root: string, startRel: string): Detection {
  // Prefer the nearest solution at or above the project.
  let rel = startRel;
  for (;;) {
    const entries = safeReaddir(path.join(root, rel));
    const slns = entries.filter((e) => /\.(sln|slnx)$/i.test(e));
    if (slns.length === 1) {
      const sln = slns[0]!;
      return {
        candidate: {
          ecosystem: 'dotnet',
          moduleRoot: rel,
          build: { executable: 'dotnet', args: ['build', sln, '--nologo'], cwd: rel || '.' },
          test: { executable: 'dotnet', args: ['test', sln, '--nologo', '--no-build'], cwd: rel || '.' },
          notes: [`Solution ${path.posix.join(rel, sln)}`]
        }
      };
    }
    if (slns.length > 1) {
      return { problem: `dotnet: several solutions in "${rel || '.'}" (${slns.join(', ')}); set "test" in .souschef.json.` };
    }
    if (rel === '') break;
    const parent = path.posix.dirname(rel);
    rel = parent === '.' ? '' : parent;
  }
  // No solution: look for exactly one test project.
  const testProjects = findFiles(root, '', (name, full) => /\.(csproj|fsproj|vbproj)$/i.test(name) && isTestProject(full), 5, 20);
  if (testProjects.length === 1) {
    const proj = testProjects[0]!;
    return {
      candidate: {
        ecosystem: 'dotnet',
        moduleRoot: '',
        build: { executable: 'dotnet', args: ['build', proj, '--nologo'], cwd: '.' },
        test: { executable: 'dotnet', args: ['test', proj, '--nologo', '--no-build'], cwd: '.' },
        notes: [`Test project ${proj}`]
      }
    };
  }
  if (testProjects.length > 1) {
    return { problem: `dotnet: no solution and several test projects (${testProjects.join(', ')}); set "test" in .souschef.json.` };
  }
  return { problem: 'dotnet: no solution and no test project found; create a test project or set "test" in .souschef.json.' };
}

function isTestProject(file: string): boolean {
  const text = safeRead(file);
  return /Microsoft\.NET\.Test\.Sdk|<IsTestProject>\s*true/i.test(text);
}

function detectNode(root: string, rel: string, dir: string): Detection | undefined {
  let pkg: { scripts?: Record<string, string>; packageManager?: string };
  try {
    pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return { problem: `node: "${path.posix.join(rel, 'package.json')}" is not valid JSON.` };
  }
  const script = pkg.scripts?.test;
  if (!script || /no test specified/.test(script)) {
    return { problem: `node: "${path.posix.join(rel, 'package.json')}" has no usable "test" script; add one or set "test" in .souschef.json.` };
  }
  const pm = detectPackageManager(root, rel, pkg.packageManager);
  return {
    candidate: {
      ecosystem: 'node',
      moduleRoot: rel,
      test: { executable: pm, args: pm === 'npm' ? ['test', '--silent'] : ['test'], cwd: rel || '.' },
      notes: [`package manager: ${pm}`, `test script: ${script}`]
    }
  };
}

function detectPackageManager(root: string, rel: string, declared?: string): string {
  if (declared) {
    const name = declared.split('@')[0];
    if (name && ['npm', 'pnpm', 'yarn', 'bun'].includes(name)) return name;
  }
  let cur = rel;
  for (;;) {
    const entries = safeReaddir(path.join(root, cur));
    if (entries.includes('pnpm-lock.yaml')) return 'pnpm';
    if (entries.includes('yarn.lock')) return 'yarn';
    if (entries.includes('bun.lockb') || entries.includes('bun.lock')) return 'bun';
    if (entries.includes('package-lock.json')) return 'npm';
    if (cur === '') return 'npm';
    const parent = path.posix.dirname(cur);
    cur = parent === '.' ? '' : parent;
  }
}

function pythonCandidate(rel: string, dir: string, entries: string[]): Candidate {
  const cwd = rel || '.';
  if (entries.includes('uv.lock')) {
    return { ecosystem: 'python', moduleRoot: rel, test: { executable: 'uv', args: ['run', 'pytest', '-q'], cwd }, notes: ['runner: uv'] };
  }
  if (entries.includes('poetry.lock')) {
    return { ecosystem: 'python', moduleRoot: rel, test: { executable: 'poetry', args: ['run', 'pytest', '-q'], cwd }, notes: ['runner: poetry'] };
  }
  for (const venv of ['.venv', 'venv']) {
    const py = process.platform === 'win32' ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python');
    if (existsSync(path.join(dir, py))) {
      return {
        ecosystem: 'python',
        moduleRoot: rel,
        test: { executable: py.split(path.sep).join('/'), args: ['-m', 'pytest', '-q'], cwd },
        notes: [`virtualenv: ${venv}`]
      };
    }
  }
  return { ecosystem: 'python', moduleRoot: rel, test: { executable: 'python', args: ['-m', 'pytest', '-q'], cwd }, notes: ['interpreter from PATH'] };
}

/** Up to three existing test files the agent can copy conventions from. */
export function findTestExamples(root: string, moduleRoot: string, writeGlobs: string[], targets: string[]): string[] {
  const isTest = picomatch(writeGlobs, { dot: true, nocase: process.platform === 'win32' });
  const exts = new Set(targets.map((t) => path.extname(t).toLowerCase()).filter(Boolean));
  const all = findFiles(
    root,
    moduleRoot,
    (_name, full) => {
      const rel = path.relative(root, full).split(path.sep).join('/');
      return isTest(rel) && /\.(cs|fs|ts|tsx|js|jsx|mjs|py|go|rs|java|kt)$/i.test(rel);
    },
    6,
    200
  );
  const preferred = all.filter((f) => exts.has(path.extname(f).toLowerCase()));
  return (preferred.length > 0 ? preferred : all).slice(0, 3);
}

function findFiles(
  root: string,
  startRel: string,
  match: (name: string, full: string) => boolean,
  maxDepth: number,
  limit: number
): string[] {
  const out: string[] = [];
  const walk = (rel: string, depth: number) => {
    if (out.length >= limit) return;
    const dir = path.join(root, rel);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= limit) return;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (depth < maxDepth && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(childRel, depth + 1);
      } else if (e.isFile() && match(e.name, path.join(root, childRel))) {
        out.push(childRel);
      }
    }
  };
  if (isInside(root, path.join(root, startRel))) walk(startRel, 0);
  return out;
}

function safeRead(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export type { TestPlan };
