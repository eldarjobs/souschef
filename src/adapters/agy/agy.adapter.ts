import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { SousChefConfig } from '../../config/config-loader.js';
import type { ProcessRunner } from '../../core/process-runner.js';
import { resolveExecutable } from '../../security/command-policy.js';
import type { AgentUsage } from '../../types.js';
import type { AgentAdapter, AgentRunRequest, AgentRunResult } from '../agent-adapter.js';

interface AgyJsonResult {
  conversation_id?: string;
  status?: string;
  response?: string;
  structured_output?: unknown;
  num_turns?: number;
  duration_seconds?: number;
  error?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    thinking_tokens?: number;
    cache_read_tokens?: number;
    total_tokens?: number;
  };
}

/**
 * Antigravity CLI (`agy`) in headless print mode with JSON output.
 * Uses the structured fields (status, structured_output, usage, conversation_id)
 * instead of scraping terminal text.
 */
export class AgyAdapter implements AgentAdapter {
  readonly name = 'antigravity';

  constructor(
    private readonly runner: ProcessRunner,
    private readonly cfg: SousChefConfig['agent'],
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  private executable(): string | undefined {
    if (this.cfg.executable) return resolveExecutable(this.cfg.executable, this.env);
    const fromEnv = this.env.SOUSCHEF_AGY;
    if (fromEnv && existsSync(fromEnv)) return fromEnv;
    const onPath = resolveExecutable('agy', this.env);
    if (onPath) return onPath;
    // Where the installer puts it when `agy install` has not added it to PATH.
    const candidates =
      process.platform === 'win32'
        ? [path.join(this.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local'), 'agy', 'bin', 'agy.exe')]
        : [path.join(homedir(), '.local', 'bin', 'agy'), path.join(homedir(), '.agy', 'bin', 'agy'), '/usr/local/bin/agy'];
    return candidates.find((c) => existsSync(c));
  }

  async checkAvailable(): Promise<{ ok: boolean; detail: string }> {
    const exe = this.executable();
    return exe ? { ok: true, detail: exe } : { ok: false, detail: 'agy executable not found on PATH (set agent.executable in .souschef.json)' };
  }

  buildArgs(req: AgentRunRequest, schemaFile?: string): string[] {
    const timeoutSec = Math.max(30, Math.floor(req.timeoutMs / 1000) - 15);
    const args = [
      ...this.cfg.prefixArgs,
      '--print',
      req.prompt,
      '--output-format',
      'json',
      '--print-timeout',
      `${timeoutSec}s`,
      '--disable-slash-commands'
    ];
    if (schemaFile) args.push('--json-schema', schemaFile);
    if (req.resumeSessionId) args.push('--conversation', req.resumeSessionId);
    if (this.cfg.model) args.push('--model', this.cfg.model);
    if (this.cfg.effort) args.push('--effort', this.cfg.effort);
    if (this.cfg.permissionMode === 'accept-edits') args.push('--mode', 'accept-edits');
    else args.push('--dangerously-skip-permissions');
    if (this.cfg.permissionMode === 'skip-permissions-sandboxed') args.push('--sandbox');
    args.push(...this.cfg.extraArgs);
    return args;
  }

  async run(req: AgentRunRequest): Promise<AgentRunResult> {
    const exe = this.executable();
    if (!exe) {
      return {
        ok: false,
        status: 'UNAVAILABLE',
        durationMs: 0,
        exitCode: null,
        timedOut: false,
        cancelled: false,
        rawOutput: '',
        error: 'agy executable not found'
      };
    }
    let schemaFile: string | undefined;
    if (req.outputSchema) {
      mkdirSync(req.scratchDir, { recursive: true });
      schemaFile = path.join(req.scratchDir, 'agent-output.schema.json');
      writeFileSync(schemaFile, JSON.stringify(req.outputSchema));
    }
    const outcome = await this.runner.run(
      { file: exe, args: this.buildArgs(req, schemaFile), viaShell: false },
      {
        cwd: req.cwd,
        timeoutMs: req.timeoutMs,
        maxOutputBytes: req.maxOutputBytes,
        taskId: req.taskId,
        onSpawn: req.onSpawn,
        env: { ...this.env, NO_COLOR: '1' }
      }
    );
    const parsed = parseAgyJson(outcome.output);
    const status = parsed?.status ?? (outcome.timedOut ? 'TIMEOUT' : outcome.cancelled ? 'CANCELLED' : 'UNKNOWN');
    const ok = !outcome.timedOut && !outcome.cancelled && outcome.exitCode === 0 && status === 'SUCCESS';
    return {
      ok,
      status,
      sessionId: parsed?.conversation_id,
      response: parsed?.response,
      structured: parsed?.structured_output ?? tryParseJson(parsed?.response),
      usage: toUsage(parsed?.usage),
      turns: parsed?.num_turns,
      durationMs: outcome.durationMs,
      exitCode: outcome.exitCode,
      timedOut: outcome.timedOut,
      cancelled: outcome.cancelled,
      rawOutput: outcome.output,
      error: ok ? undefined : parsed?.error ?? (parsed ? `agent status ${status}` : 'agent produced no JSON result')
    };
  }
}

/** Finds the JSON result object in agy's stdout (tolerates log lines around it). */
export function parseAgyJson(output: string): AgyJsonResult | undefined {
  const lines = output.split(/\r?\n/).filter((l) => l.trim().startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i--) {
    const obj = tryParseJson(lines[i]!.trim());
    if (obj && typeof obj === 'object' && ('status' in obj || 'conversation_id' in obj)) return obj as AgyJsonResult;
  }
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const obj = tryParseJson(output.slice(start, end + 1));
    if (obj && typeof obj === 'object') return obj as AgyJsonResult;
  }
  return undefined;
}

function tryParseJson(text: string | undefined): unknown {
  if (!text) return undefined;
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(stripped);
  } catch {
    return undefined;
  }
}

function toUsage(u: AgyJsonResult['usage']): AgentUsage | undefined {
  if (!u) return undefined;
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    thinkingTokens: u.thinking_tokens ?? 0,
    cacheReadTokens: u.cache_read_tokens ?? 0,
    totalTokens: u.total_tokens ?? 0
  };
}
