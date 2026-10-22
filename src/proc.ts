import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export const isWindows = process.platform === "win32";

/** First match for `name` on PATH. On Windows .exe is preferred: .cmd shims cannot be spawned without a shell. */
export function findOnPath(name: string): string | undefined {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const extensions = isWindows ? [".exe", ".com"] : [""];
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Ends a process and everything it started. Always by PID, never by image name. */
export function killTree(pid: number): void {
  if (isWindows) {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    return;
  }
  // Runs are spawned detached on POSIX, so the agent leads its own process group.
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
