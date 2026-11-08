import { posix } from "node:path";
import { renderInvestigationPromptPart, type InvestigationPromptParts } from "@responder/core/investigations/prompt-parts";
import { sandboxWorkspaceRoot } from "@responder/core/sandbox-config";
import type { CheckedOutRepository } from "./repositories.js";
import type { SandboxSession } from "./sandbox-session.js";

// A workspace can have each checked-out repository's dependencies installed
// after checkout, so its agents can run tests. Each lockfile is installed
// with its package manager in its own folder. An install that fails or runs
// out of time never fails the run: the agent is told what happened and where
// the log is.

export interface DependencyInstall {
  command: string;
  // The lockfile's folder relative to the repository, "" for its root.
  directory: string;
  // The lockfile's path relative to the repository.
  lockfile: string;
  // The folder the install creates. When it is missing, the install runs again.
  output: "node_modules" | ".venv";
  // The program the command needs on PATH.
  program: string;
}

// Lockfiles deeper than this are not installed.
const maxLockfileDepth = 3;
const skippedFolders = ["node_modules", ".git", ".venv", "vendor"];

// Several JavaScript lockfiles in one folder install once, with the first.
const javaScriptLockfiles: Array<{ command: string; file: string; program: string }> = [
  { command: "pnpm install --frozen-lockfile", file: "pnpm-lock.yaml", program: "pnpm" },
  { command: "bun install --frozen-lockfile", file: "bun.lock", program: "bun" },
  { command: "bun install --frozen-lockfile", file: "bun.lockb", program: "bun" },
  // Yarn's command depends on the folder; see yarnInstall.
  { command: "", file: "yarn.lock", program: "" },
  { command: "npm ci", file: "npm-shrinkwrap.json", program: "npm" },
  { command: "npm ci", file: "package-lock.json", program: "npm" },
];
const yarnBerryConfig = ".yarnrc.yml";
const uvLockfile = "uv.lock";
const listedFiles = [...javaScriptLockfiles.map(({ file }) => file), yarnBerryConfig, uvLockfile];

// Yarn 2 and later keep a .yarnrc.yml beside the lockfile and run through
// corepack. Yarn 1 is not in the sandbox, so npx fetches it.
function yarnInstall(berry: boolean): Pick<DependencyInstall, "command" | "program"> {
  return berry
    ? { command: "corepack yarn install --immutable", program: "corepack" }
    : { command: "npx --yes yarn@1 install --frozen-lockfile", program: "npx" };
}

// The installs for a repository, from the paths of its files relative to its
// root. Root installs come first, then shallower folders.
export function detectDependencyInstalls(files: string[]): DependencyInstall[] {
  const folders = new Map<string, Set<string>>();
  for (const file of files) {
    const path = file.trim().replace(/^\.\//u, "");
    const parts = path.split("/");
    if (!path || parts.length > maxLockfileDepth) continue;
    if (parts.slice(0, -1).some((part) => skippedFolders.includes(part))) continue;
    const directory = posix.dirname(path) === "." ? "" : posix.dirname(path);
    const names = folders.get(directory) ?? new Set<string>();
    names.add(posix.basename(path));
    folders.set(directory, names);
  }
  const installs: DependencyInstall[] = [];
  const directories = [...folders.keys()].sort((left, right) =>
    depth(left) - depth(right) || left.localeCompare(right));
  for (const directory of directories) {
    const names = folders.get(directory)!;
    const lockfilePath = (name: string) => directory ? `${directory}/${name}` : name;
    const javaScript = javaScriptLockfiles.find(({ file }) => names.has(file));
    if (javaScript) {
      installs.push({
        ...(javaScript.file === "yarn.lock"
          ? yarnInstall(names.has(yarnBerryConfig))
          : { command: javaScript.command, program: javaScript.program }),
        directory,
        lockfile: lockfilePath(javaScript.file),
        output: "node_modules",
      });
    }
    if (names.has(uvLockfile)) {
      installs.push({
        command: "uv sync --frozen",
        directory,
        lockfile: lockfilePath(uvLockfile),
        output: ".venv",
        program: "uv",
      });
    }
  }
  return installs;
}

function depth(directory: string): number {
  return directory ? directory.split("/").length : 0;
}

export interface DependencyInstallResult {
  command: string;
  // What happened, for the agent, such as "failed with exit code 1".
  detail: string;
  // The folder the command ran in.
  directory: string;
  log: string | null;
  repository: string;
  status: "failed" | "installed" | "skipped";
}

export const dependencyInstallRoot = `${sandboxWorkspaceRoot}/.responder/dependencies`;
const installTimeoutMs = 10 * 60_000;
// All of a run's installs share this time.
const installBudgetMs = 15 * 60_000;
// Too little time left to start another install.
const minimumInstallMs = 30_000;
const timeoutExitCodes = new Set([124, 137]);

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function commandSucceeded(output: string): boolean {
  return /(?:^|\n)Process exited with code 0(?:\n|$)/u.test(output);
}

function commandOutput(output: string): string {
  return output.split("\nOutput:\n", 2)[1] ?? "";
}

function minutes(milliseconds: number): string {
  const count = Math.round(milliseconds / 60_000);
  return `${count} minute${count === 1 ? "" : "s"}`;
}

// Names a repository's install in the dependencies folder, for example
// acme--app--frontend--package-lock.json.
function installFileName(repository: string, lockfile: string): string {
  return `${repository}/${lockfile}`.split("/").join("--").replace(/[^A-Za-z0-9._-]/gu, "_");
}

async function listLockfiles(
  session: SandboxSession,
  repository: CheckedOutRepository,
): Promise<string[] | null> {
  // The names are constants that need no quoting.
  const prune = skippedFolders.map((name) => `-name ${name}`).join(" -o ");
  const names = listedFiles.map((name) => `-name ${name}`).join(" -o ");
  // An unreadable folder makes find fail, but the files it found still count.
  const output = await session.execCommand({
    cmd: `cd -- ${shellQuote(repository.path)} && { find . -maxdepth ${maxLockfileDepth} -type d \\( ${prune} \\) -prune -o -type f \\( ${names} \\) -printf '%P\\n' 2>/dev/null || true; }`,
    maxOutputTokens: 2_000,
    workdir: sandboxWorkspaceRoot,
  });
  if (!commandSucceeded(output)) return null;
  return commandOutput(output).split("\n").filter(Boolean);
}

// One install. It skips a lockfile whose install already succeeded in this
// sandbox and whose output folder is still there, and one that already
// failed, so a thread's later turns do not wait for it again. The output
// folder is excluded from git, so a pull request never includes it. It
// prints one outcome line.
function installScript(
  install: DependencyInstall,
  repositoryPath: string,
  files: { log: string; marker: string },
  timeoutSeconds: number,
): string {
  const directory = install.directory ? `${repositoryPath}/${install.directory}` : repositoryPath;
  const excluded = `/${install.directory ? `${install.directory}/` : ""}${install.output}/`;
  return [
    "set -u",
    `repo=${shellQuote(repositoryPath)}`,
    `dir=${shellQuote(directory)}`,
    `lock=${shellQuote(posix.basename(install.lockfile))}`,
    `marker=${shellQuote(files.marker)}`,
    `log=${shellQuote(files.log)}`,
    `mkdir -p -- ${shellQuote(dependencyInstallRoot)}`,
    `hash=$(sha256sum -- "$dir/$lock" 2>/dev/null | cut -d ' ' -f 1)`,
    `if [ -z "$hash" ]; then echo 'responder-install: missing-lockfile'; exit 0; fi`,
    `previous=$(cat -- "$marker" 2>/dev/null || true)`,
    `if [ "$previous" = "installed $hash" ] && [ -d "$dir"/${shellQuote(install.output)} ]; then echo 'responder-install: current'; exit 0; fi`,
    `if [ "$previous" = "failed $hash" ]; then echo 'responder-install: failed-earlier'; exit 0; fi`,
    `if ! bash -lc ${shellQuote(`command -v ${install.program}`)} >/dev/null 2>&1; then echo 'responder-install: missing-program'; exit 0; fi`,
    `if [ -d "$repo/.git" ] && mkdir -p -- "$repo/.git/info" && ! grep -qxF -- ${shellQuote(excluded)} "$repo/.git/info/exclude" 2>/dev/null; then printf '%s\\n' ${shellQuote(excluded)} >>"$repo/.git/info/exclude"; fi`,
    "status=0",
    `(cd -- "$dir" && CI=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 timeout -k 10 ${timeoutSeconds} bash -lc ${shellQuote(install.command)}) >"$log" 2>&1 </dev/null || status=$?`,
    `if [ "$status" -eq 0 ]; then printf 'installed %s\\n' "$hash" >"$marker"; else printf 'failed %s\\n' "$hash" >"$marker"; fi`,
    `echo "responder-install: exit $status"`,
  ].join("\n");
}

function installOutcome(
  output: string,
  install: DependencyInstall,
  timeoutMs: number,
): Pick<DependencyInstallResult, "detail" | "status"> & { logged: boolean } {
  const outcome = commandSucceeded(output)
    ? /(?:^|\n)responder-install: (\S+)(?: (\d+))?/u.exec(commandOutput(output))
    : null;
  switch (outcome?.[1]) {
    case "current":
      return { detail: "already installed", logged: true, status: "installed" };
    case "failed-earlier":
      return { detail: "failed earlier in this sandbox, not run again", logged: true, status: "failed" };
    case "missing-program":
      return { detail: `skipped, ${install.program} is not on PATH`, logged: false, status: "skipped" };
    case "missing-lockfile":
      return { detail: "skipped, the lockfile could not be read", logged: false, status: "skipped" };
    case "exit": {
      const code = Number(outcome[2]);
      if (code === 0) return { detail: "installed", logged: true, status: "installed" };
      return timeoutExitCodes.has(code)
        ? { detail: `failed, stopped after ${minutes(timeoutMs)}`, logged: true, status: "failed" }
        : { detail: `failed with exit code ${code}`, logged: true, status: "failed" };
    }
    default:
      return { detail: "failed, the sandbox command did not finish", logged: true, status: "failed" };
  }
}

// Installs the dependencies of each repository, one install at a time, and
// reports each. Only an aborted run makes it throw.
export async function installRepositoryDependencies(
  session: SandboxSession,
  repositories: CheckedOutRepository[],
  options: {
    budgetMs?: number;
    installTimeoutMs?: number;
    now?: () => number;
    signal?: AbortSignal;
  } = {},
): Promise<DependencyInstallResult[]> {
  const now = options.now ?? Date.now;
  const budgetMs = options.budgetMs ?? installBudgetMs;
  const timeoutMs = options.installTimeoutMs ?? installTimeoutMs;
  const startedAt = now();
  const results: DependencyInstallResult[] = [];
  for (const repository of repositories) {
    options.signal?.throwIfAborted();
    let files: string[] | null;
    try {
      files = await listLockfiles(session, repository);
    } catch {
      files = null;
    }
    options.signal?.throwIfAborted();
    if (!files) {
      console.error(JSON.stringify({
        event: "repository_dependency_listing_failed",
        repository: repository.repository,
      }));
      continue;
    }
    for (const install of detectDependencyInstalls(files)) {
      options.signal?.throwIfAborted();
      const directory = install.directory ? `${repository.path}/${install.directory}` : repository.path;
      const name = installFileName(repository.repository, install.lockfile);
      const log = `${dependencyInstallRoot}/${name}.log`;
      const result = { command: install.command, directory, repository: repository.repository };
      const remainingMs = budgetMs - (now() - startedAt);
      if (remainingMs < minimumInstallMs) {
        results.push({
          ...result,
          detail: `skipped, the ${minutes(budgetMs)} for installs ran out`,
          log: null,
          status: "skipped",
        });
        continue;
      }
      const limitMs = Math.min(timeoutMs, remainingMs);
      let output = "";
      try {
        output = await session.execCommand({
          cmd: installScript(
            install,
            repository.path,
            { log, marker: `${dependencyInstallRoot}/${name}.marker` },
            Math.ceil(limitMs / 1_000),
          ),
          maxOutputTokens: 200,
          workdir: sandboxWorkspaceRoot,
        });
      } catch {
        options.signal?.throwIfAborted();
      }
      const { logged, ...outcome } = installOutcome(output, install, limitMs);
      results.push({ ...result, ...outcome, log: logged ? log : null });
    }
  }
  return results;
}

// Tells the agent which dependencies are installed, and where to look for
// the ones that are not.
export function repositoryDependencyInstructions(
  results: DependencyInstallResult[],
  promptParts?: InvestigationPromptParts,
): string | null {
  if (results.length === 0) return null;
  const prompt = (key: string, values: Record<string, string> = {}) =>
    renderInvestigationPromptPart(key, promptParts, values);
  return [
    prompt("dependencyHeader"),
    ...results.map((result) => prompt("dependencyEntry", {
      command: result.command,
      directory: result.directory,
      repository: result.repository,
      result: result.log ? `${result.detail}. Log: ${result.log}` : result.detail,
    })),
    prompt("dependencyUsage"),
  ].join("\n");
}
