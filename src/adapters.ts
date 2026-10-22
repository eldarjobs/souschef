import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { findOnPath, isWindows } from "./proc.js";

export interface AdapterRunInput {
  prompt: string;
  logFile: string;
  timeoutMinutes: number;
  /** Resume this conversation instead of starting a new one. */
  conversationId?: string;
}

/** One headless coding-agent CLI. Adding a backend means adding one of these. */
export interface Adapter {
  id: string;
  name: string;
  installHint: string;
  locate(): string | undefined;
  args(input: AdapterRunInput): string[];
  /** Pulls the agent's conversation id out of its log, so a follow-up run can resume it. */
  conversationId(log: string): string | undefined;
}

const agy: Adapter = {
  id: "agy",
  name: "Antigravity CLI",
  installHint: "Install the Antigravity CLI (agy), run `agy` once in a terminal and sign in. Set SOUSCHEF_AGY to its path if it is not on PATH.",

  locate() {
    const fromEnv = process.env.SOUSCHEF_AGY;
    if (fromEnv && existsSync(fromEnv)) return fromEnv;

    const onPath = findOnPath("agy");
    if (onPath) return onPath;

    // Where the installer puts it when `agy install` has not added it to PATH.
    const candidates = isWindows
      ? [path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "agy", "bin", "agy.exe")]
      : [path.join(os.homedir(), ".local", "bin", "agy"), path.join(os.homedir(), ".agy", "bin", "agy"), "/usr/local/bin/agy"];
    return candidates.find((candidate) => existsSync(candidate));
  },

  args({ prompt, logFile, timeoutMinutes, conversationId }) {
    return [
      // Print mode has nobody to approve tool calls. The brief, and the write guard after the
      // run, are what keep the agent inside the test folders.
      "--dangerously-skip-permissions",
      "--print-timeout", `${timeoutMinutes}m`,
      "--log-file", logFile,
      ...(conversationId ? ["--conversation", conversationId] : []),
      "-p", prompt,
    ];
  },

  conversationId(log) {
    return /Created conversation ([0-9a-f-]{36})/i.exec(log)?.[1];
  },
};

export const adapters: Record<string, Adapter> = { agy };

export function getAdapter(id: string): Adapter {
  const adapter = adapters[id];
  if (!adapter) throw new Error(`Unknown adapter '${id}'. Available: ${Object.keys(adapters).join(", ")}.`);
  return adapter;
}
