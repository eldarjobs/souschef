import type { AgentUsage } from '../types.js';

export interface AgentRunRequest {
  taskId: string;
  /** Workspace directory the agent operates in. */
  cwd: string;
  prompt: string;
  /** Continue an earlier agent conversation (used for repair attempts). */
  resumeSessionId?: string;
  /** JSON Schema the agent's final answer must follow. */
  outputSchema?: object;
  /** Directory for adapter scratch files (schema files etc.). Outside the workspace. */
  scratchDir: string;
  timeoutMs: number;
  maxOutputBytes: number;
  onSpawn?: (pid: number) => void;
}

export interface AgentRunResult {
  /** The agent process finished and reported success. Says nothing about test quality. */
  ok: boolean;
  status: string;
  sessionId?: string;
  response?: string;
  structured?: unknown;
  usage?: AgentUsage;
  turns?: number;
  durationMs: number;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  /** Redacted, size-limited raw output; stored for diagnostics, never returned by default. */
  rawOutput: string;
  error?: string;
}

/**
 * Contract every coding agent integration implements. The core engine only talks
 * to this interface, so Gemini CLI / Codex adapters can be added without touching it.
 */
export interface AgentAdapter {
  readonly name: string;
  checkAvailable(): Promise<{ ok: boolean; detail: string }>;
  run(req: AgentRunRequest): Promise<AgentRunResult>;
}

export function addUsage(a: AgentUsage | undefined, b: AgentUsage | undefined): AgentUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    thinkingTokens: a.thinkingTokens + b.thinkingTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    totalTokens: a.totalTokens + b.totalTokens
  };
}
