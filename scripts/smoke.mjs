// End-to-end check against the real agent: builds a throwaway Node project with one planted bug,
// drives the bundled server over stdio exactly as an MCP client would, and prints every answer.
//
//   npm run build && npm run smoke
//
// It spends real agent time (a few minutes). The project folder is kept for inspection.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "plugin", "dist", "server.cjs");
const project = mkdtempSync(path.join(os.tmpdir(), "souschef-smoke-"));

function write(file, text) {
  mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
  writeFileSync(path.join(project, file), text);
}

const buggy = `export function sum(a, b) {
  return a + b;
}

export function isEven(n) {
  return n % 2 === 1;
}
`;

write("package.json", JSON.stringify({ name: "smoke", private: true, type: "module", scripts: { test: "node --test" } }, null, 2));
write("src/math.js", buggy);
const git = (...args) =>
  execFileSync("git", ["-c", "user.name=smoke", "-c", "user.email=smoke@example.invalid", "-c", "core.autocrlf=false", ...args], { cwd: project });
git("init", "-q");
git("add", ".");
git("commit", "-q", "-m", "init");

console.log(`project: ${project}`);

const client = new Client({ name: "souschef-smoke", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], cwd: project, env: process.env, stderr: "inherit" }));

const LONG = { timeout: 30 * 60 * 1000 };
async function call(name, args) {
  const answer = await client.callTool({ name, arguments: { cwd: project, ...args } }, undefined, LONG);
  const text = answer.content.map((c) => c.text).join("\n");
  if (answer.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
}

async function follow(run) {
  let view = run;
  console.log(`run ${view.run_id} started`);
  for (const line of view.events) console.log(`  ${line}`);
  while (view.state === "running") {
    view = await call("wait_run", { run_id: view.run_id, cursor: view.cursor, max_wait_seconds: 120 });
    for (const line of view.events) console.log(`  ${line}`);
  }
  console.log(JSON.stringify({ state: view.state, reason: view.reason, out_of_scope: view.out_of_scope, result: view.result }, null, 2));
  return view;
}

console.log("tools:", (await client.listTools()).tools.map((t) => t.name).join(", "));
console.log("doctor:", JSON.stringify(await call("doctor", { ping: true }), null, 2));

const first = await follow(await call("start_run", {
  feature: "math helpers sum and isEven",
  changed_files: ["src/math.js"],
  requirements: [
    "SETUP: put the tests in test/math.test.js using node:test and node:assert/strict.",
    "sum(2, 3) returns 5; sum(-2, -3) returns -5; sum(0, 0) returns 0.",
    "isEven(2) and isEven(0) return true; isEven(3) and isEven(-3) return false.",
  ],
  timeout_minutes: 10,
}));

if (first.state === "failed") {
  write("src/math.js", buggy.replace("n % 2 === 1", "n % 2 === 0"));
  await follow(await call("continue_run", {
    run_id: first.run_id,
    feedback: "You were right: isEven used `n % 2 === 1`. I fixed it in src/math.js to `n % 2 === 0`. Run the tests again and report.",
    timeout_minutes: 10,
  }));
}

console.log("list_runs:", JSON.stringify(await call("list_runs", {}), null, 2));
await client.close();
