import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmdirSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import { getAdapter, type Adapter } from "./adapters.js";
import { renderBrief, renderFollowUp, type TestTask } from "./brief.js";
import { changedSince, gitTopLevel, snapshot, type Snapshot } from "./git.js";
import { isAlive, isWindows, killTree } from "./proc.js";
import { loadProject, type ProjectSettings } from "./project.js";

export type RunState = "running" | "passed" | "failed" | "error" | "cancelled" | "timeout";

export interface RunEvent {
  seq: number;
  at: string;
  type: string;
  message: string;
}

/** What a run's state.json holds. */
export interface RunRecord {
  id: string;
  parentId?: string;
  root: string;
  adapter: string;
  state: RunState;
  startedAt: string;
  endedAt?: string;
  pid?: number;
  exitCode?: number | null;
  conversationId?: string;
  reason?: string;
  testCommand: string;
  writeGlobs: string[];
  timeoutMinutes: number;
  changedFiles?: string[];
  outOfScope?: string[];
}

export interface RunView {
  run_id: string;
  parent_run_id?: string;
  state: RunState;
  elapsed_seconds: number;
  run_dir: string;
  conversation_id?: string;
  /** Pass back as `cursor` to get only what happened after this view. */
  cursor: number;
  events: string[];
  reason?: string;
  changed_files?: string[];
  out_of_scope?: string[];
  result?: unknown;
  note?: string;
}

interface LiveRun {
  record: RunRecord;
  dir: string;
  adapter: Adapter;
  events: RunEvent[];
  listeners: Set<() => void>;
  top?: string;
  baseline: Snapshot;
  reported: Set<string>;
  poller?: NodeJS.Timeout;
  killer?: NodeJS.Timeout;
  polling?: Promise<void>;
  finishing: boolean;
  cancelled: boolean;
  timedOut: boolean;
  /** agy leaves an empty logs/ folder in its working directory. */
  logsDirWasAbsent: boolean;
}

const STATE_DIR = ".souschef";
const POLL_MS = 3000;
/** Lets a burst of events (several files written together) arrive as one wait_run answer. */
const EVENT_DEBOUNCE_MS = 5000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function newRunId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${stamp}-${randomBytes(2).toString("hex")}`;
}

/** The path the agent sees: relative to the project root, forward slashes. */
function relRunPath(id: string, file: string): string {
  return `${STATE_DIR}/runs/${id}/${file}`;
}

function runsDir(root: string): string {
  return path.join(root, STATE_DIR, "runs");
}

function readText(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function readJson(file: string): unknown {
  const text = readText(file).replace(/^﻿/, "");
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function locateOrThrow(adapter: Adapter): string {
  const binary = adapter.locate();
  if (!binary) throw new Error(`${adapter.name} was not found. ${adapter.installHint}`);
  return binary;
}

/** "14:03:21 file: src/foo.test.ts", in local time. */
function formatEvent(event: RunEvent): string {
  return `${new Date(event.at).toTimeString().slice(0, 8)} ${event.type}: ${event.message}`;
}

function minutesSince(iso: string): string {
  return `${((Date.now() - Date.parse(iso)) / 60000).toFixed(1)}m`;
}

export interface StartOptions {
  root: string;
  task: TestTask;
  adapter?: string;
  testCommand?: string;
  writeGlobs?: string[];
  timeoutMinutes?: number;
}

export class RunManager {
  private readonly runs = new Map<string, LiveRun>();

  async start(options: StartOptions): Promise<RunView> {
    this.ensureIdle(options.root);
    const project = loadProject(options.root);
    const settings: ProjectSettings = {
      ...project,
      adapter: options.adapter ?? project.adapter,
      testCommand: options.testCommand ?? project.testCommand,
      writeGlobs: options.writeGlobs?.length ? options.writeGlobs : project.writeGlobs,
      timeoutMinutes: options.timeoutMinutes ?? project.timeoutMinutes,
    };
    const adapter = getAdapter(settings.adapter);
    const binary = locateOrThrow(adapter);

    const run = this.create(settings, adapter);
    const id = run.record.id;
    writeFileSync(path.join(run.dir, "task.json"), JSON.stringify(options.task, null, 2));
    writeFileSync(path.join(run.dir, "brief.md"), renderBrief(id, options.task, settings, relRunPath(id, "result.json")));

    await this.launch(run, binary);
    return this.view(run, 0);
  }

  async continueRun(root: string, parentId: string, feedback: string, timeoutMinutes?: number): Promise<RunView> {
    const parent = this.runs.get(parentId)?.record ?? this.readRecord(root, parentId);
    if (parent.state === "running") {
      throw new Error(`Run ${parentId} is still running. Wait for it to finish or cancel it first.`);
    }
    this.ensureIdle(parent.root);

    const adapter = getAdapter(parent.adapter);
    const binary = locateOrThrow(adapter);
    const settings: ProjectSettings = {
      ...loadProject(parent.root),
      adapter: parent.adapter,
      testCommand: parent.testCommand,
      writeGlobs: parent.writeGlobs,
      timeoutMinutes: timeoutMinutes ?? parent.timeoutMinutes,
    };

    const run = this.create(settings, adapter, parent.id);
    const id = run.record.id;
    const parentTask = path.join(runsDir(parent.root), parent.id, "task.json");
    if (existsSync(parentTask)) writeFileSync(path.join(run.dir, "task.json"), readText(parentTask));
    writeFileSync(
      path.join(run.dir, "brief.md"),
      renderFollowUp(id, parent.id, relRunPath(parent.id, "brief.md"), relRunPath(parent.id, "result.json"), feedback, relRunPath(id, "result.json")),
    );

    await this.launch(run, binary, parent.conversationId);
    return this.view(run, 0);
  }

  async wait(root: string, id: string, cursor: number, maxWaitSeconds: number, returnOnEvent: boolean): Promise<RunView> {
    const run = this.runs.get(id);
    if (!run) return this.diskView(root, id, cursor);

    const deadline = Date.now() + maxWaitSeconds * 1000;
    while (run.record.state === "running" && Date.now() < deadline) {
      if (returnOnEvent && this.lastSeq(run) > cursor) {
        await sleep(Math.min(EVENT_DEBOUNCE_MS, Math.max(0, deadline - Date.now())));
        break;
      }
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          run.listeners.delete(done);
          resolve();
        };
        const timer = setTimeout(done, Math.max(0, deadline - Date.now()));
        run.listeners.add(done);
      });
    }
    return this.view(run, cursor);
  }

  cancel(root: string, id: string): RunView {
    const run = this.runs.get(id);
    if (!run) {
      // A run this server process did not start: its PID may since belong to something else.
      const view = this.diskView(root, id, 0);
      if (view.state === "running") {
        view.note = "This server did not start the run (it was restarted since), so it will not kill the PID. Stop the agent manually if it is still working.";
      }
      return view;
    }
    if (run.record.state === "running") {
      run.cancelled = true;
      this.emit(run, "cancel", "cancel requested");
      if (run.record.pid) killTree(run.record.pid);
    }
    return this.view(run, 0);
  }

  list(root: string, limit: number): Array<Record<string, unknown>> {
    const dir = runsDir(root);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .sort()
      .reverse()
      .slice(0, limit)
      .map((id) => {
        const record = this.runs.get(id)?.record ?? this.tryReadRecord(root, id);
        const task = readJson(path.join(dir, id, "task.json")) as { feature?: string } | undefined;
        return {
          run_id: id,
          parent_run_id: record?.parentId,
          state: record?.state ?? "unknown",
          started_at: record?.startedAt,
          ended_at: record?.endedAt,
          feature: task?.feature,
        };
      });
  }

  // ---------------------------------------------------------------------------------------------

  /** Two agents writing tests into one working tree at once would trample each other. */
  private ensureIdle(root: string): void {
    for (const run of this.runs.values()) {
      if (run.record.state === "running" && path.resolve(run.record.root) === path.resolve(root)) {
        throw new Error(`Run ${run.record.id} is still running in this project. Wait for it or cancel it first.`);
      }
    }
  }

  private create(settings: ProjectSettings, adapter: Adapter, parentId?: string): LiveRun {
    const id = newRunId();
    const dir = path.join(runsDir(settings.root), id);
    mkdirSync(dir, { recursive: true });

    // Keeps the run folders out of git without touching the project's own .gitignore.
    const ignore = path.join(settings.root, STATE_DIR, ".gitignore");
    if (!existsSync(ignore)) writeFileSync(ignore, "*\n");

    const run: LiveRun = {
      record: {
        id,
        parentId,
        root: settings.root,
        adapter: adapter.id,
        state: "running",
        startedAt: new Date().toISOString(),
        testCommand: settings.testCommand,
        writeGlobs: settings.writeGlobs,
        timeoutMinutes: settings.timeoutMinutes,
      },
      dir,
      adapter,
      events: [],
      listeners: new Set(),
      baseline: new Map(),
      reported: new Set(),
      finishing: false,
      cancelled: false,
      timedOut: false,
      logsDirWasAbsent: false,
    };
    this.runs.set(id, run);
    return run;
  }

  private async launch(run: LiveRun, binary: string, conversationId?: string): Promise<void> {
    const { record, dir, adapter } = run;

    run.top = await gitTopLevel(record.root);
    if (run.top) run.baseline = await snapshot(record.root, run.top);
    run.logsDirWasAbsent = !existsSync(path.join(record.root, "logs"));

    const prompt =
      `Read ${relRunPath(record.id, "brief.md")} and carry out every instruction in it. ` +
      `You are finished only when ${relRunPath(record.id, "result.json")} exists.`;
    const args = adapter.args({ prompt, logFile: path.join(dir, "agent.log"), timeoutMinutes: record.timeoutMinutes, conversationId });

    const out = openSync(path.join(dir, "agent.out.txt"), "w");
    const err = openSync(path.join(dir, "agent.err.txt"), "w");
    try {
      const child = spawn(binary, args, {
        cwd: record.root,
        stdio: ["ignore", out, err],
        windowsHide: true,
        detached: !isWindows,
      });
      record.pid = child.pid;
      child.on("error", (error) => {
        record.reason = `Could not start ${adapter.name}: ${error.message}`;
        void this.finish(run, null);
      });
      child.on("exit", (code) => void this.finish(run, code));
    } finally {
      closeSync(out);
      closeSync(err);
    }

    this.emit(run, "started", `${adapter.name} started (pid ${record.pid ?? "?"})${conversationId ? `, resuming conversation ${conversationId}` : ""}`);
    run.poller = setInterval(() => void this.poll(run), POLL_MS);
    // The agent has its own --print-timeout; this is the backstop if it ignores it.
    run.killer = setTimeout(() => {
      run.timedOut = true;
      if (record.pid) killTree(record.pid);
    }, (record.timeoutMinutes + 5) * 60_000);
    this.persist(run);
  }

  private poll(run: LiveRun): Promise<void> {
    run.polling ??= this.pollOnce(run).finally(() => {
      run.polling = undefined;
    });
    return run.polling;
  }

  private async pollOnce(run: LiveRun): Promise<void> {
    const { record } = run;
    if (run.top) {
      const now = await snapshot(record.root, run.top);
      const inScope = picomatch(record.writeGlobs, { dot: true });
      for (const file of changedSince(run.baseline, now)) {
        if (run.reported.has(file) || file.startsWith(`${STATE_DIR}/`)) continue;
        run.reported.add(file);
        this.emit(run, inScope(file) ? "file" : "file_out_of_scope", file);
      }
    }
    if (!record.conversationId) {
      const id = run.adapter.conversationId(readText(path.join(run.dir, "agent.log")));
      if (id) {
        record.conversationId = id;
        this.emit(run, "conversation", id);
        this.persist(run);
      }
    }
  }

  private async finish(run: LiveRun, exitCode: number | null): Promise<void> {
    if (run.finishing) return;
    run.finishing = true;
    clearInterval(run.poller);
    clearTimeout(run.killer);

    const { record, dir, adapter } = run;
    await run.polling;
    await this.pollOnce(run);

    record.exitCode = exitCode;
    record.endedAt = new Date().toISOString();
    this.emit(run, "exited", `${adapter.name} exited with code ${exitCode ?? "none"} after ${minutesSince(record.startedAt)}`);

    const logsDir = path.join(record.root, "logs");
    if (run.logsDirWasAbsent && existsSync(logsDir) && readdirSync(logsDir).length === 0) {
      try {
        rmdirSync(logsDir);
      } catch {
        // leave it
      }
    }

    if (run.top) {
      const changed = changedSince(run.baseline, await snapshot(record.root, run.top))
        .filter((file) => !file.startsWith(`${STATE_DIR}/`));
      const inScope = picomatch(record.writeGlobs, { dot: true });
      record.changedFiles = changed;
      record.outOfScope = changed.filter((file) => !inScope(file));
      if (record.outOfScope.length) {
        this.emit(run, "guard", `changed outside write_globs: ${record.outOfScope.join(", ")}`);
      }
    }

    const result = readJson(path.join(dir, "result.json")) as { status?: unknown; summary?: Record<string, unknown> } | undefined;
    if (run.cancelled) {
      record.state = "cancelled";
      record.reason ??= "Cancelled on request.";
    } else if (run.timedOut) {
      record.state = "timeout";
      record.reason = `Killed after ${record.timeoutMinutes + 5} minutes.`;
    } else if (result && typeof result === "object") {
      record.state = result.status === "passed" || result.status === "failed" ? result.status : "error";
      if (record.state === "error") record.reason ??= `The agent reported status '${String(result.status)}'. See result.json.`;
    } else {
      record.state = "error";
      const printed = readText(path.join(dir, "agent.out.txt")).trim();
      record.reason ??= printed === "" && exitCode === 0
        ? "The agent printed nothing and wrote no result. It is most likely not signed in: run the doctor tool."
        : `The agent exited (code ${exitCode ?? "none"}) without writing result.json. See agent.out.txt and agent.log in the run folder.`;
    }

    const counts = result?.summary
      ? ` total=${String(result.summary.total)} passed=${String(result.summary.passed)} failed=${String(result.summary.failed)}`
      : "";
    this.emit(run, "done", `${record.state}${counts}${record.reason && record.state !== "passed" && record.state !== "failed" ? ` - ${record.reason}` : ""}`);
    this.persist(run);
    this.notify(run);
  }

  private emit(run: LiveRun, type: string, message: string): void {
    const event: RunEvent = { seq: this.lastSeq(run) + 1, at: new Date().toISOString(), type, message };
    run.events.push(event);
    appendFileSync(path.join(run.dir, "events.jsonl"), JSON.stringify(event) + "\n");
    this.notify(run);
  }

  private notify(run: LiveRun): void {
    for (const listener of [...run.listeners]) listener();
  }

  private lastSeq(run: LiveRun): number {
    return run.events.at(-1)?.seq ?? 0;
  }

  private persist(run: LiveRun): void {
    writeFileSync(path.join(run.dir, "state.json"), JSON.stringify(run.record, null, 2));
  }

  private view(run: LiveRun, cursor: number): RunView {
    const { record, dir } = run;
    const terminal = record.state !== "running";
    const end = record.endedAt ? Date.parse(record.endedAt) : Date.now();
    return {
      run_id: record.id,
      parent_run_id: record.parentId,
      state: record.state,
      elapsed_seconds: Math.round((end - Date.parse(record.startedAt)) / 1000),
      run_dir: dir,
      conversation_id: record.conversationId,
      cursor: this.lastSeq(run),
      events: run.events.filter((e) => e.seq > cursor).map(formatEvent),
      ...(terminal && {
        reason: record.reason,
        changed_files: record.changedFiles,
        out_of_scope: record.outOfScope,
        result: readJson(path.join(dir, "result.json")),
      }),
    };
  }

  private tryReadRecord(root: string, id: string): RunRecord | undefined {
    return readJson(path.join(runsDir(root), id, "state.json")) as RunRecord | undefined;
  }

  private readRecord(root: string, id: string): RunRecord {
    const record = this.tryReadRecord(root, id);
    if (!record) throw new Error(`No run '${id}' under ${runsDir(root)}.`);
    return record;
  }

  /** A run started by an earlier server process: report what its folder says. */
  private diskView(root: string, id: string, cursor: number): RunView {
    const record = this.readRecord(root, id);
    const dir = path.join(runsDir(root), id);
    const events = readText(path.join(dir, "events.jsonl"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RunEvent);
    const result = readJson(path.join(dir, "result.json")) as { status?: unknown } | undefined;

    let state = record.state;
    let note: string | undefined;
    if (state === "running") {
      if (result?.status === "passed" || result?.status === "failed") {
        state = result.status;
        note = "Finished after the server that started it went away; only result.json is available.";
      } else if (!record.pid || !isAlive(record.pid)) {
        state = "error";
        note = "The server that started this run went away and the agent is no longer running.";
      } else {
        note = "Started by an earlier server process, so no live progress is available. Call again later.";
      }
    }

    return {
      run_id: record.id,
      parent_run_id: record.parentId,
      state,
      elapsed_seconds: Math.round(((record.endedAt ? Date.parse(record.endedAt) : Date.now()) - Date.parse(record.startedAt)) / 1000),
      run_dir: dir,
      conversation_id: record.conversationId,
      cursor: events.at(-1)?.seq ?? 0,
      events: events.filter((e) => e.seq > cursor).map(formatEvent),
      reason: record.reason,
      changed_files: record.changedFiles,
      out_of_scope: record.outOfScope,
      result,
      note,
    };
  }
}
