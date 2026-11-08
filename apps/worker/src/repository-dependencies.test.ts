import { sandboxWorkspaceRoot } from "@responder/core/sandbox-config";
import { describe, expect, it, vi } from "vitest";
import {
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

  it("looks three levels deep and skips installed and vendored folders", () => {
    expect(detectDependencyInstalls([
      "./apps/web/package-lock.json",
      "apps/web/deep/package-lock.json",
      "node_modules/left-pad/package-lock.json",
      "frontend/node_modules/x/yarn.lock",
      ".git/pnpm-lock.yaml",
      "api/.venv/uv.lock",
      "vendor/lib/package-lock.json",
    ]).map((install) => install.lockfile)).toEqual(["apps/web/package-lock.json"]);
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
        log: `${logs}/acme--app--pnpm-lock.yaml.log`,
        repository: "acme/app",
        status: "installed",
      },
      {
        command: "npm ci",
        detail: "installed",
        directory: `${root}/frontend`,
        log: `${logs}/acme--app--frontend--package-lock.json.log`,
        repository: "acme/app",
        status: "installed",
      },
    ]);
    const listing = execCommand.mock.calls[0]![0].cmd;
    expect(listing).toContain(`cd -- '${root}'`);
    expect(listing).toContain("-maxdepth 3");
    expect(listing).toMatch(/-name node_modules -o -name \.git -o -name \.venv -o -name vendor/u);
    const [, npm] = installCommands(execCommand);
    expect(npm).toContain(`dir='${root}/frontend'`);
    expect(npm).toContain("lock='package-lock.json'");
    expect(npm).toContain(`marker='${logs}/acme--app--frontend--package-lock.json.marker'`);
    expect(npm).toContain("CI=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 timeout -k 10 600 bash -lc 'npm ci'");
    expect(npm).toContain('[ -d "$dir"/\'node_modules\' ]');
    expect(npm).toContain("command -v npm");
    expect(npm).toContain(`repo='${root}'`);
    expect(npm).toContain(`printf '%s\\n' '/frontend/node_modules/' >>"$repo/.git/info/exclude"`);
    expect(npm).toContain("sha256sum");
  });

  it("reports what an earlier turn installed, and does not retry what failed", async () => {
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
    const { session } = fakeSession({
      files: "package-lock.json\nuv.lock\napi/pnpm-lock.yaml\nweb/bun.lock\n",
      installs: {
        "bun.lock": new Error("sandbox connection lost"),
        "package-lock.json": "responder-install: exit 1",
        "pnpm-lock.yaml": "responder-install: exit 124",
        "uv.lock": "responder-install: missing-program",
      },
    });

    const results = await installRepositoryDependencies(session, [repository]);

    expect(results.map(({ command, detail, log, status }) => ({ command, detail, log, status }))).toEqual([
      { command: "npm ci", detail: "failed with exit code 1", log: `${logs}/acme--app--package-lock.json.log`, status: "failed" },
      { command: "uv sync --frozen", detail: "skipped, uv is not on PATH", log: null, status: "skipped" },
      { command: "pnpm install --frozen-lockfile", detail: "failed, stopped after 10 minutes", log: `${logs}/acme--app--api--pnpm-lock.yaml.log`, status: "failed" },
      { command: "bun install --frozen-lockfile", detail: "failed, the sandbox command did not finish", log: `${logs}/acme--app--web--bun.lock.log`, status: "failed" },
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

  it("quotes folder names", async () => {
    const { execCommand, session } = fakeSession({ files: "it's/package-lock.json\n" });
    await installRepositoryDependencies(session, [repository]);
    expect(installCommands(execCommand)[0]).toContain(`dir='${root}/it'\\''s'`);
  });
});

describe("repository dependency instructions", () => {
  it("lists each install with its result and log", () => {
    const results: DependencyInstallResult[] = [
      { command: "npm ci", detail: "installed", directory: `${root}/frontend`, log: `${logs}/a.log`, repository: "acme/app", status: "installed" },
      { command: "uv sync --frozen", detail: "skipped, uv is not on PATH", directory: root, log: null, repository: "acme/app", status: "skipped" },
    ];
    expect(repositoryDependencyInstructions(results)).toBe([
      "Responder installed the checked-out repositories' dependencies after checkout, with CI=1:",
      `- acme/app, ${root}/frontend: npm ci: installed. Log: ${logs}/a.log`,
      `- acme/app, ${root}: uv sync --frozen: skipped, uv is not on PATH`,
      "Installed dependencies are ready for tests and builds. Where an install failed or was skipped, read its log and install what your checks need yourself.",
    ].join("\n"));
  });

  it("adds nothing when no repository has a lockfile", () => {
    expect(repositoryDependencyInstructions([])).toBeNull();
  });
});
