import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { CommandSpec } from '../types.js';

/** Toolchains the discovery layer may emit. Anything else must be allow-listed in config. */
export const BUILTIN_EXECUTABLES = [
  'dotnet',
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'npx',
  'node',
  'python',
  'python3',
  'py',
  'pytest',
  'uv',
  'poetry',
  'go',
  'cargo',
  'mvn',
  'gradle',
  'git'
];

// Arguments reaching a Windows .cmd shim pass through cmd.exe, so only a
// conservative character set is allowed there.
const SAFE_SHIM_ARG = /^[A-Za-z0-9_@%+=:,./\\-]*$/;

export class CommandPolicyError extends Error {}

export interface ResolvedCommand {
  file: string;
  args: string[];
  /** True when the target is a .cmd/.bat shim that needs cmd.exe on Windows. */
  viaShell: boolean;
}

export class CommandPolicy {
  private readonly allowed: Set<string>;

  constructor(
    extraAllowed: string[] = [],
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly platform: NodeJS.Platform = process.platform
  ) {
    this.allowed = new Set([...BUILTIN_EXECUTABLES, ...extraAllowed].map((e) => normalizeName(e)));
  }

  isAllowed(executable: string): boolean {
    return this.allowed.has(normalizeName(executable));
  }

  /** Validates a command and resolves it to an absolute executable without a shell. */
  resolve(spec: CommandSpec): ResolvedCommand {
    if (!this.isAllowed(spec.executable)) {
      throw new CommandPolicyError(
        `Executable "${spec.executable}" is not allowed. Add it to allowedExecutables in .souschef.json.`
      );
    }
    for (const arg of spec.args) {
      if (arg.includes('\0') || /[\r\n]/.test(arg)) throw new CommandPolicyError('Command arguments may not contain control characters.');
    }
    const file = resolveExecutable(spec.executable, this.env, this.platform);
    if (!file) throw new CommandPolicyError(`Executable "${spec.executable}" was not found on PATH.`);
    const viaShell = this.platform === 'win32' && /\.(cmd|bat)$/i.test(file);
    if (viaShell) {
      for (const arg of spec.args) {
        if (!SAFE_SHIM_ARG.test(arg)) {
          throw new CommandPolicyError(`Argument "${arg}" is not allowed for the Windows shim ${path.basename(file)}.`);
        }
      }
    }
    return { file, args: spec.args, viaShell };
  }
}

function normalizeName(executable: string): string {
  return path.basename(executable).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
}

export function resolveExecutable(
  executable: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  const isFile = (p: string) => {
    try {
      return existsSync(p) && statSync(p).isFile();
    } catch {
      return false;
    }
  };
  const exts =
    platform === 'win32'
      ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase())]
      : [''];
  // Prefer real executables over extensionless files on Windows (npm ships both).
  const ordered = platform === 'win32' ? [...exts.slice(1), ''] : exts;

  if (path.isAbsolute(executable) || executable.includes('/') || executable.includes('\\')) {
    for (const ext of ordered) if (isFile(executable + ext)) return executable + ext;
    return undefined;
  }
  const pathVar = env.PATH ?? env.Path ?? '';
  for (const dir of pathVar.split(path.delimiter).filter(Boolean)) {
    for (const ext of ordered) {
      const candidate = path.join(dir, executable + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}
