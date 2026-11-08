import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxWorkspaceRoot } from "@responder/core/sandbox-config";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dependencyInstallScript,
  detectDependencyInstalls,
  installRepositoryDependencies,
  repositoryDependencyInstructions,
  type DependencyInstallResult,
} from "./repository-dependencies.js";
import type { SandboxSession } from "./sandbox-session.js";

const root = `${sandboxWorkspaceRoot}/repositories/acme/app`;
const repository = {
  branch: "main",
  path: root,
  repository: "acme/app",
  sha: "a".repeat(40),
  workspaceBaseSha: "a".repeat(40),
};
const logs = `${sandboxWorkspaceRoot}/.responder/dependencies`;

// Where an install of acme/app's lockfile keeps its log or marker.
function installFile(lockfile: string, extension: "log" | "marker"): string {
  const hash = createHash("sha256").update(`acme/app\0${lockfile}`).digest("hex").slice(0, 12);
  return `${logs}/acme--app--${lockfile.split("/").join("--")}-${hash}.${extension}`;
}

function commandResponse(output: string, exitCode = 0): string {
  return `Chunk ID: abc123\nWall time: 0.0100 seconds\nProcess exited with code ${exitCode}\nOutput:\n${output}`;
}

describe("dependency install detection", () => {
  it("installs each lockfile with its package manager in its folder", () => {
    expect(detectDependencyInstalls([
      "pnpm-lock.yaml",
      "frontend/package-lock.json",
      "services/api/uv.lock",
      "docs/bun.lockb",
      "tools/bun.lock",
      "legacy/yarn.lock",
      "web/yarn.lock",
      "web/.yarnrc.yml",
      "cli/npm-shrinkwrap.json",
      "README.md",
    ])).toEqual([
      { command: "pnpm install --frozen-lockfile", directory: "", lockfile: "pnpm-lock.yaml", output: "node_modules", program: "pnpm" },
      { command: "npm ci", directory: "cli", lockfile: "cli/npm-shrinkwrap.json", output: "node_modules", program: "npm" },
      { command: "bun install --frozen-lockfile", directory: "docs", lockfile: "docs/bun.lockb", output: "node_modules", program: "bun" },
      { command: "npm ci", directory: "frontend", lockfile: "frontend/package-lock.json", output: "node_modules", program: "npm" },
      { command: "npx --yes yarn@1 install --frozen-lockfile", directory: "legacy", lockfile: "legacy/yarn.lock", output: "node_modules", program: "npx" },
      { command: "bun install --frozen-lockfile", directory: "tools", lockfile: "tools/bun.lock", output: "node_modules", program: "bun" },
      { command: "corepack yarn install --immutable", directory: "web", lockfile: "web/yarn.lock", output: "node_modules", program: "corepack" },
      { command: "uv sync --frozen", directory: "services/api", lockfile: "services/api/uv.lock", output: ".venv", program: "uv" },
    ]);
  });

  it("installs a folder with several JavaScript lockfiles once, preferring pnpm, bun, yarn, then npm", () => {
    const commands = (files: string[]) => detectDependencyInstalls(files).map((install) => install.lockfile);
    expect(commands(["package-lock.json", "yarn.lock", "bun.lock", "pnpm-lock.yaml", "uv.lock"]))
      .toEqual(["pnpm-lock.yaml", "uv.lock"]);
    expect(commands(["package-lock.json", "yarn.lock", "bun.lockb"])).toEqual(["bun.lockb"]);
    expect(commands(["bun.lockb", "bun.lock"])).toEqual(["bun.lock"]);
    expect(commands(["package-lock.json", "yarn.lock"])).toEqual(["yarn.lock"]);
    expect(commands(["npm-shrinkwrap.json", "package-lock.json"])).toEqual(["npm-shrinkwrap.json"]);
  });

  it("looks three folders deep and skips installed and vendored folders", () => {
    expect(detectDependencyInstalls([
      "./apps/web/package-lock.json",
      "apps/web/deep/package-lock.json",
      "apps/web/deep/deeper/package-lock.json",
      "node_modules/left-pad/package-lock.json",
      "frontend/node_modules/x/yarn.lock",
      ".git/pnpm-lock.yaml",
      "api/.venv/uv.lock",
      "vendor/lib/package-lock.json",
    ]).map((install) => install.lockfile)).toEqual([
      "apps/web/package-lock.json",
      "apps/web/deep/package-lock.json",
    ]);
  });
});

// A sandbox whose installs answer with the given outcome line, by lockfile.
function fakeSession(input: {
  files: string;
  installs?: Record<string, string | Error>;
}) {
  const execCommand = vi.fn(async ({ cmd }: { cmd: string }) => {
    if (cmd.includes("find .")) return commandResponse(input.files);
    const lockfile = /^lock='([^']*)'$/mu.exec(cmd)?.[1] ?? "";
    const outcome = input.installs?.[lockfile] ?? "responder-install: exit 0";
    if (outcome instanceof Error) throw outcome;
    return commandResponse(`${outcome}\n`);
  });
  return { execCommand, session: { execCommand } as unknown as SandboxSession };
}

function installCommands(execCommand: ReturnType<typeof fakeSession>["execCommand"]): string[] {
  return execCommand.mock.calls.map(([call]) => call.cmd).filter((cmd) => !cmd.includes("find ."));
}

describe("repository dependency installs", () => {
  it("runs each install in its folder with CI set, a time limit, and a log", async () => {
    const { execCommand, session } = fakeSession({
      files: "pnpm-lock.yaml\nfrontend/package-lock.json\n",
    });

    const results = await installRepositoryDependencies(session, [repository]);

    expect(results).toEqual([
      {
        command: "pnpm install --frozen-lockfile",
        detail: "installed",
        directory: root,
        log: installFile("pnpm-lock.yaml", "log"),
        repository: "acme/app",
        status: "installed",
      },
      {
        command: "npm ci",
        detail: "installed",
        directory: `${root}/frontend`,
        log: installFile("frontend/package-lock.json", "log"),
        repository: "acme/app",
        status: "installed",
      },
    ]);
    const listing = execCommand.mock.calls[0]![0].cmd;
    expect(listing).toContain(`cd -- '${root}'`);
    expect(listing).toContain("-maxdepth 4");
    expect(listing).toMatch(/-name node_modules -o -name \.git -o -name \.venv -o -name vendor/u);
    const [, npm] = installCommands(execCommand);
    expect(npm).toContain(`dir='${root}/frontend'`);
    expect(npm).toContain("lock='package-lock.json'");
    expect(npm).toContain(`marker='${installFile("frontend/package-lock.json", "marker")}'`);
    expect(npm).toContain("CI=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 timeout -k 10 600 bash -lc 'npm ci'");
    expect(npm).toContain('[ -d "$dir"/\'node_modules\' ]');
    expect(npm).toContain("command -v npm");
    expect(npm).toContain(`repo='${root}'`);
    expect(npm).toContain(`printf '%s\\n' '/frontend/node_modules/' >>"$repo/.git/info/exclude"`);
    expect(npm).toContain("sha256sum");
  });

  it("reports installs an earlier turn finished or saw fail", async () => {
    const { session } = fakeSession({
      files: "package-lock.json\nuv.lock\n",
      installs: {
        "package-lock.json": "responder-install: current",
        "uv.lock": "responder-install: failed-earlier",
      },
    });

    const results = await installRepositoryDependencies(session, [repository]);

    expect(results.map(({ detail, status }) => ({ detail, status }))).toEqual([
      { detail: "already installed", status: "installed" },
      { detail: "failed earlier in this sandbox, not run again", status: "failed" },
    ]);
  });

  it("does not fail the run when installs fail, stop, or cannot start", async () => {
    const { execCommand, session } = fakeSession({
      files: "package-lock.json\nuv.lock\napi/pnpm-lock.yaml\nweb/bun.lock\nweb/uv.lock\n",
      installs: {
        "bun.lock": new Error("sandbox connection lost"),
        "package-lock.json": "responder-install: exit 1",
        "pnpm-lock.yaml": "responder-install: exit 124",
        "uv.lock": "responder-install: missing-program",
      },
    });
    execCommand.mockImplementation(async ({ cmd }: { cmd: string }) => {
      if (cmd.includes("find .")) return commandResponse("package-lock.json\nuv.lock\napi/pnpm-lock.yaml\nweb/bun.lock\nweb/uv.lock\n");
      if (cmd.includes("dir='/home/daytona/workspace/repositories/acme/app/web'") && cmd.includes("lock='uv.lock'")) {
        return commandResponse("responder-install: exit 137\n");
      }
      const lockfile = /^lock='([^']*)'$/mu.exec(cmd)?.[1] ?? "";
      const outcome = {
        "bun.lock": new Error("sandbox connection lost"),
        "package-lock.json": "responder-install: exit 1",
        "pnpm-lock.yaml": "responder-install: exit 124",
        "uv.lock": "responder-install: missing-program",
      }[lockfile] ?? "responder-install: exit 0";
      if (outcome instanceof Error) throw outcome;
      return commandResponse(`${outcome}\n`);
    });

    const results = await installRepositoryDependencies(session, [repository]);

    expect(results.map(({ command, detail, log, status }) => ({ command, detail, log, status }))).toEqual([
      { command: "npm ci", detail: "failed with exit code 1", log: installFile("package-lock.json", "log"), status: "failed" },
      { command: "uv sync --frozen", detail: "skipped, uv is not on PATH", log: null, status: "skipped" },
      { command: "pnpm install --frozen-lockfile", detail: "failed, stopped after 10 minutes", log: installFile("api/pnpm-lock.yaml", "log"), status: "failed" },
      // The command never reported back, so it may have written no log.
      { command: "bun install --frozen-lockfile", detail: "failed, the sandbox command did not finish", log: null, status: "failed" },
      // A SIGKILL, such as from running out of memory, is not a timeout.
      { command: "uv sync --frozen", detail: "failed, killed with exit code 137", log: installFile("web/uv.lock", "log"), status: "failed" },
    ]);
  });

  it("stops starting installs when the run's install time is used up", async () => {
    let clock = 0;
    const { execCommand, session } = fakeSession({ files: "package-lock.json\nweb/package-lock.json\napi/uv.lock\n" });
    execCommand.mockImplementation(async ({ cmd }: { cmd: string }) => {
      if (cmd.includes("find .")) return commandResponse("package-lock.json\nweb/package-lock.json\napi/uv.lock\n");
      clock += 10 * 60_000;
      return commandResponse("responder-install: exit 0\n");
    });

    const results = await installRepositoryDependencies(session, [repository], { now: () => clock });

    expect(results.map(({ detail }) => detail)).toEqual([
      "installed",
      "installed",
      "skipped, the 15 minutes for installs ran out",
    ]);
    const [first, second] = installCommands(execCommand);
    expect(first).toContain("timeout -k 10 600 ");
    // Only 5 of the 15 minutes were left.
    expect(second).toContain("timeout -k 10 300 ");
  });

  it("skips a repository whose files cannot be listed", async () => {
    const execCommand = vi.fn(async () => commandResponse("find: permission denied", 1));
    const session = { execCommand } as unknown as SandboxSession;
    await expect(installRepositoryDependencies(session, [repository])).resolves.toEqual([]);
  });

  it("stops when the run is aborted", async () => {
    const controller = new AbortController();
    const { execCommand, session } = fakeSession({ files: "package-lock.json\n" });
    execCommand.mockImplementationOnce(async () => {
      controller.abort(new Error("run stopped"));
      return commandResponse("package-lock.json\n");
    });
    await expect(installRepositoryDependencies(session, [repository], { signal: controller.signal }))
      .rejects.toThrow("run stopped");
  });

  it("gives installs whose readable names match their own log and marker", async () => {
    const { session } = fakeSession({ files: "x--y/package-lock.json\nx/y/package-lock.json\n" });
    const [first, second] = await installRepositoryDependencies(session, [repository]);
    expect(first!.log).toBe(installFile("x--y/package-lock.json", "log"));
    expect(second!.log).toBe(installFile("x/y/package-lock.json", "log"));
    expect(first!.log).not.toBe(second!.log);
  });

  it("quotes folder names", async () => {
    const { execCommand, session } = fakeSession({ files: "it's/package-lock.json\n" });
    await installRepositoryDependencies(session, [repository]);
    expect(installCommands(execCommand)[0]).toContain(`dir='${root}/it'\\''s'`);
  });
});

// Runs the generated script in bash against a temporary repository. A stub
// timeout stands in for the install, records each run, and exits with the
// code in its exit-code file.
const shellTools = ["bash", "sha256sum", "cut", "grep"].every((tool) => {
  try {
    execFileSync("sh", ["-c", `command -v ${tool}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
});
describe.skipIf(!shellTools)("dependency install script", () => {
  let scratch = "";
  afterEach(() => {
    if (scratch) rmSync(scratch, { force: true, recursive: true });
  });

  function setup() {
    scratch = mkdtempSync(join(tmpdir(), "responder-deps-"));
    const repositoryPath = join(scratch, "repo");
    const bin = join(scratch, "bin");
    mkdirSync(join(repositoryPath, ".git"), { recursive: true });
    mkdirSync(join(repositoryPath, "frontend"), { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(repositoryPath, "frontend", "package-lock.json"), "{}\n");
    const runs = join(scratch, "runs");
    const exitCode = join(scratch, "exit-code");
    writeFileSync(exitCode, "0");
    writeFileSync(join(bin, "timeout"), `#!/bin/sh\necho run >> '${runs}'\nexit "$(cat '${exitCode}')"\n`);
    writeFileSync(join(bin, "npm"), "#!/bin/sh\n");
    chmodSync(join(bin, "timeout"), 0o755);
    chmodSync(join(bin, "npm"), 0o755);
    const [install] = detectDependencyInstalls(["frontend/package-lock.json"]);
    const script = dependencyInstallScript(
      install!,
      repositoryPath,
      { log: join(scratch, "deps", "install.log"), marker: join(scratch, "deps", "install.marker") },
      600,
    );
    const run = () => execFileSync("bash", ["-c", script], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    }).trim();
    const runCount = () => existsSync(runs) ? readFileSync(runs, "utf8").split("\n").filter(Boolean).length : 0;
    return { exitCode, repositoryPath, run, runCount };
  }

  it("does not run an install again after it failed for the same lockfile", () => {
    const { exitCode, repositoryPath, run, runCount } = setup();
    writeFileSync(exitCode, "1");

    expect(run()).toBe("responder-install: exit 1");
    expect(run()).toBe("responder-install: failed-earlier");
    expect(runCount()).toBe(1);

    writeFileSync(join(repositoryPath, "frontend", "package-lock.json"), "{\"changed\":true}\n");
    writeFileSync(exitCode, "0");
    expect(run()).toBe("responder-install: exit 0");
    expect(runCount()).toBe(2);
  });

  it("skips an install that succeeded while its output folder is there", () => {
    const { repositoryPath, run, runCount } = setup();

    expect(run()).toBe("responder-install: exit 0");
    mkdirSync(join(repositoryPath, "frontend", "node_modules"));
    expect(run()).toBe("responder-install: current");
    expect(runCount()).toBe(1);

    rmSync(join(repositoryPath, "frontend", "node_modules"), { recursive: true });
    expect(run()).toBe("responder-install: exit 0");
    expect(runCount()).toBe(2);
    // The output folder is excluded from git once.
    expect(readFileSync(join(repositoryPath, ".git", "info", "exclude"), "utf8")).toBe("/frontend/node_modules/\n");
  });
});

describe("repository dependency instructions", () => {
  it("lists each install with its result and log", () => {
    const results: DependencyInstallResult[] = [
      { command: "npm ci", detail: "installed", directory: `${root}/frontend`, log: `${logs}/a.log`, repository: "acme/app", status: "installed" },
      { command: "uv sync --frozen", detail: "skipped, uv is not on PATH", directory: root, log: null, repository: "acme/app", status: "skipped" },
    ];
    expect(repositoryDependencyInstructions(results)).toBe([
      "Responder tried to install the checked-out repositories' dependencies after checkout, with CI=1:",
      `- acme/app, ${root}/frontend: npm ci: installed. Log: ${logs}/a.log`,
      `- acme/app, ${root}: uv sync --frozen: skipped, uv is not on PATH`,
      "Installed dependencies are ready for tests and builds. Where an install failed or was skipped, read its log if it lists one, and install what your checks need yourself.",
    ].join("\n"));
  });

  it("adds nothing when no repository has a lockfile", () => {
    expect(repositoryDependencyInstructions([])).toBeNull();
  });
});
