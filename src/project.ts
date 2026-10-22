import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const CONFIG_FILE = ".souschef.json";

export interface ProjectSettings {
  root: string;
  adapter: string;
  /** Empty when nothing was configured or detected: the agent is told to work it out. */
  testCommand: string;
  /** Where the agent may create or change files, relative to the root. */
  writeGlobs: string[];
  /** Extra project rules appended to the brief. */
  rules: string[];
  timeoutMinutes: number;
  /** Where testCommand and writeGlobs came from. */
  source: "config" | "detected" | "none";
  configPath?: string;
}

interface ConfigFile {
  adapter?: string;
  test_command?: string;
  write_globs?: string[];
  rules?: string[];
  timeout_minutes?: number;
}

interface Detected {
  testCommand: string;
  writeGlobs: string[];
}

const DOTNET_GLOBS = ["**/*Test*/**", "**/*test*/**"];
const JS_GLOBS = ["**/*.test.*", "**/*.spec.*", "**/__tests__/**", "**/test/**", "**/tests/**"];
const PYTHON_GLOBS = ["**/test_*.py", "**/*_test.py", "**/tests/**", "**/conftest.py"];

function list(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** A .sln at the root or one level down, as a path relative to the root. */
function findSolution(root: string): string | undefined {
  const atRoot = list(root).find((f) => f.endsWith(".sln") || f.endsWith(".slnx"));
  if (atRoot) return atRoot;
  for (const entry of list(root)) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const nested = list(path.join(root, entry)).find((f) => f.endsWith(".sln") || f.endsWith(".slnx"));
    if (nested) return `${entry}/${nested}`;
  }
  return undefined;
}

function detect(root: string): Detected | undefined {
  const has = (file: string) => existsSync(path.join(root, file));

  const solution = findSolution(root);
  if (solution || list(root).some((f) => f.endsWith(".csproj"))) {
    return { testCommand: solution ? `dotnet test ${solution}` : "dotnet test", writeGlobs: DOTNET_GLOBS };
  }

  if (has("package.json")) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
      if (pkg.scripts?.test) {
        const runner = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lock") || has("bun.lockb") ? "bun run" : "npm";
        return { testCommand: `${runner} test`, writeGlobs: JS_GLOBS };
      }
    } catch {
      // unreadable package.json: fall through
    }
    return { testCommand: "", writeGlobs: JS_GLOBS };
  }

  if (["pyproject.toml", "pytest.ini", "setup.cfg", "tox.ini"].some(has)) {
    return { testCommand: "pytest", writeGlobs: PYTHON_GLOBS };
  }
  if (has("go.mod")) return { testCommand: "go test ./...", writeGlobs: ["**/*_test.go", "**/testdata/**"] };
  if (has("Cargo.toml")) return { testCommand: "cargo test", writeGlobs: ["**/tests/**"] };
  return undefined;
}

export function loadProject(root: string): ProjectSettings {
  const configPath = path.join(root, CONFIG_FILE);
  let config: ConfigFile = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf8")) as ConfigFile;
    } catch (error) {
      throw new Error(`${CONFIG_FILE} is not valid JSON: ${(error as Error).message}`);
    }
  }

  const detected = detect(root);
  const configured = config.test_command !== undefined || config.write_globs !== undefined;

  return {
    root,
    adapter: config.adapter ?? "agy",
    testCommand: config.test_command ?? detected?.testCommand ?? "",
    writeGlobs: config.write_globs ?? detected?.writeGlobs ?? ["**/test/**", "**/tests/**"],
    rules: config.rules ?? [],
    timeoutMinutes: config.timeout_minutes ?? 60,
    source: configured ? "config" : detected ? "detected" : "none",
    configPath: existsSync(configPath) ? configPath : undefined,
  };
}
