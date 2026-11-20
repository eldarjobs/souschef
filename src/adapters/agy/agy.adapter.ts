import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { SousChefConfig } from '../../config/config-loader.js';
import type { ProcessRunner } from '../../core/process-runner.js';
import { resolveExecutable } from '../../security/command-policy.js';
import type { AgentUsage } from '../../types.js';
import type { AgentAdapter, AgentEvent, AgentRunRequest, AgentRunResult } from '../agent-adapter.js';

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

interface AgyStepUpdate {
  step_index?: number;
  state?: string;
  step_type?: string;
  tool_name?: string;
  duration_seconds?: number;
  text_delta?: string;
  tool_info?: { name?: string; parameters?: Record<string, unknown>; output?: string };
}

/**
 * Antigravity CLI (`agy`) in headless print mode with streaming JSON output.
 * Each step (tool call, message) is reported as it happens; the final `result`
 * event carries the structured fields (status, structured_output, usage,
 * conversation_id), so nothing is scraped from terminal text.
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
      'stream-json',
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
    const stream = new AgyStreamParser(req.cwd, req.onEvent);
    const outcome = await this.runner.run(
      { file: exe, args: this.buildArgs(req, schemaFile), viaShell: false },
      {
        cwd: req.cwd,
        timeoutMs: req.timeoutMs,
        maxOutputBytes: req.maxOutputBytes,
        taskId: req.taskId,
        onSpawn: req.onSpawn,
        onStdoutLine: (line) => stream.push(line),
        env: { ...this.env, NO_COLOR: '1' }
      }
    );
    // The bounded output buffer can drop the middle of a long stream; the live parser saw every line.
    const parsed = stream.result ?? parseAgyJson(outcome.output);
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

/**
 * Turns agy's `--output-format stream-json` lines into AgentEvents as they arrive,
 * and keeps the final `result` event.
 */
export class AgyStreamParser {
  result?: AgyJsonResult;
  /** Message text arrives in deltas; it is reported once the step is done. */
  private readonly messages = new Map<number, string>();

  constructor(
    private readonly cwd: string,
    private readonly onEvent?: (event: AgentEvent) => void
  ) {}

  push(line: string): void {
    const obj = tryParseJson(line) as { event?: string; result?: AgyJsonResult; step_update?: AgyStepUpdate } | undefined;
    if (!obj || typeof obj !== 'object') return;
    if (obj.event === 'result' && obj.result) {
      this.result = obj.result;
      return;
    }
    const step = obj.step_update;
    if (obj.event !== 'step_update' || !step) return;

    if (step.step_type === 'agent_response') {
      const key = step.step_index ?? -1;
      const text = (this.messages.get(key) ?? '') + (step.text_delta ?? '');
      if (step.state !== 'DONE') {
        this.messages.set(key, text);
        return;
      }
      this.messages.delete(key);
      // The closing structured report is JSON; the result and the task summary already say it.
      const isReport = text.trim().startsWith('{') && typeof tryParseJson(text) === 'object';
      if (text.trim() && !isReport) this.emit({ kind: 'message', text: text.trim() });
      return;
    }

    if (step.step_type !== 'tool') return;
    const state = step.state === 'ACTIVE' ? 'ACTIVE' : step.state === 'DONE' || step.state === 'ERROR' ? 'DONE' : undefined;
    if (!state) return;
    const tool = step.tool_name ?? step.tool_info?.name ?? 'tool';
    const action = toolAction(tool);
    const summary = state === 'DONE' && action === 'run' ? commandSummary(step.tool_info?.output) : undefined;
    const output = summary && stripRoot(summary, this.cwd);
    this.emit({
      kind: 'tool',
      state,
      tool,
      action,
      detail: toolDetail(step.tool_info?.parameters, this.cwd),
      ...(step.duration_seconds !== undefined ? { seconds: step.duration_seconds } : {}),
      ...(output ? { output } : {})
    });
  }

  private emit(event: AgentEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      // Progress reporting must never break the agent run.
    }
  }
}

/** write / read / run / search for the tools agy has, the raw name for anything else. */
export function toolAction(tool: string): string {
  const t = tool.toLowerCase();
  if (/write|replace|edit|sed_file/.test(t)) return 'write';
  if (/command|^run_/.test(t)) return 'run';
  if (/grep|find|list_dir|search/.test(t)) return 'search';
  if (/view|read/.test(t)) return 'read';
  return t;
}

const DETAIL_KEYS = ['CommandLine', 'Path', 'TargetFile', 'AbsolutePath', 'FilePath', 'File', 'DirectoryPath', 'SearchPath', 'SearchDirectory', 'Query', 'Pattern', 'Url'];

function toolDetail(params: Record<string, unknown> | undefined, cwd: string): string | undefined {
  if (!params) return undefined;
  const key = DETAIL_KEYS.find((k) => typeof params[k] === 'string' && params[k]);
  const value = key ? (params[key] as string) : Object.values(params).find((v): v is string => typeof v === 'string' && v.length > 0 && v.length < 300);
  return value ? stripRoot(value, cwd).slice(0, 300) : undefined;
}

/** Removes the workspace prefix wherever it appears, so paths read like the checkout's. */
function stripRoot(value: string, root: string): string {
  const base = root.replace(/[\\/]+$/, '');
  let out = value;
  for (const variant of new Set([base, base.replace(/\\/g, '/'), base.replace(/\//g, '\\')])) {
    const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`${escaped}[\\\\/]?`, process.platform === 'win32' ? 'gi' : 'g'), '');
  }
  return out || '.';
}

/**
 * "exit 0 · Passed! - Failed: 0, Passed: 55" from agy's run_command output: the exit code and
 * the last line that reads like a test summary, else simply the last line.
 */
export function commandSummary(output: string | undefined): string | undefined {
  if (!output) return undefined;
  const exit = /exited with code (-?\d+)/i.exec(output)?.[1];
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^command (exited|output)/i.test(l));
  // Stack frames ("at Foo (test_runner/test.js:9)") mention tests too; they are never the summary.
  const tail = lines.slice(-30).filter((l) => !/^at\s/.test(l)).reverse();
  const counts = /\b\d+\s+(passed|failed|tests?)\b|\b(passed|failed|pass|fail|tests?)\b[:\s]+\d+|\b(Passed|Failed)!/i;
  const last = tail.find((l) => counts.test(l)) ?? tail.find((l) => /\berrors?\b/i.test(l)) ?? tail[0] ?? lines.at(-1);
  const parts = [exit !== undefined ? `exit ${exit}` : undefined, last?.slice(0, 160)].filter(Boolean);
  return parts.length ? parts.join(' · ') : undefined;
}

/** Finds agy's result in its stdout: the `result` event of a stream, or a plain JSON object. */
export function parseAgyJson(output: string): AgyJsonResult | undefined {
  const lines = output.split(/\r?\n/).filter((l) => l.trim().startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i--) {
    const obj = tryParseJson(lines[i]!.trim()) as { event?: string; result?: AgyJsonResult } | undefined;
    if (!obj || typeof obj !== 'object') continue;
    if (obj.event === 'result' && obj.result) return obj.result;
    if ('status' in obj || 'conversation_id' in obj) return obj as AgyJsonResult;
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
