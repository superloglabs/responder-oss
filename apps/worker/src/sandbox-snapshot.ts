import { createHash } from "node:crypto";
import { sandboxProvider } from "@responder/core/sandbox-config";
import { prebuiltHarnessRoot } from "./automation-harness.js";
import type { SandboxSession } from "./sandbox-session.js";
import { claudeAgentSdkVersion } from "./claude-automation-harness.js";
import { codexCliVersion } from "./codex-automation-harness.js";
import { openCodeVersion } from "./opencode-automation-harness.js";

// The image Daytona sandboxes use when no snapshot is configured.
export const sandboxSnapshotBaseImage = "debian:12.9";

// Sandboxes start with the snapshot's resources, in vCPUs and GiB. Agents
// install and test the repositories' dependencies, which 1 GiB cannot hold.
export const sandboxSnapshotResources = { cpu: 2, disk: 10, memory: 4 };

// The repositories' toolchain. pnpm switches to each project's pinned version.
const nodeVersion = "24.22.1";
const nodeArchive = `node-v${nodeVersion}-linux-x64.tar.xz`;
const nodeArchiveSha256 = "6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6";
const pnpmVersion = "11.15.0";
const bunVersion = "1.4.4";
const ripgrepVersion = "15.1.0";
const ripgrepArchive = `ripgrep-${ripgrepVersion}-x86_64-unknown-linux-musl.tar.gz`;
const ripgrepArchiveSha256 = "1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599";
const miseVersion = "2026.11.4";
const miseBinary = `mise-v${miseVersion}-linux-x64`;
const miseBinarySha256 = "0296d9cba9324106d4e0962bb94a2072902f3658813aeb3b09504947bb8ddc2b";

// The PATH Vercel gives each command in its Node 24 image. Sessions replace
// PATH with mise's shims followed by this, so the snapshot build fails when
// Vercel changes it.
export const vercelSandboxDefaultPath = [
  "/vercel/runtimes/node24/bin",
  "/home/vercel-sandbox/.global/pnpm/bin",
  "/home/vercel-sandbox/.global/npm/bin",
  "/vercel/runtimes/node24/bin",
  "/vercel/bin",
  "/opt/git/bin",
  "/home/vercel-sandbox/.local/bin",
  "/usr/local/bin",
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
].join(":");

// mise picks each runtime's version from the version files in a command's
// directory and its parents, installing a missing one on first use. Outside
// any version file a shim runs the next match on PATH, the image's own Node.js
// or Python.
const miseShims = "/home/vercel-sandbox/.local/share/mise/shims";
export const vercelSandboxPath = `${miseShims}:${vercelSandboxDefaultPath}`;

// Where mise looks up the versions a tool has. Restricted sandboxes always
// reach it; the runtimes come from nodejs.org and GitHub, which the default
// list has.
export const miseVersionsHost = "mise-versions.jdx.dev";

const miseBinaryPath = "/usr/local/bin/mise";

const miseShimTools = ["node", "npm", "npx", "corepack", "python", "python3", "pip", "pip3", "ruby", "gem", "bundle"];
const miseConfig = [
  "[settings]",
  'idiomatic_version_file_enable_tools = ["node", "python", "ruby"]',
  // Repositories are checked out here, so their mise.toml loads without a prompt.
  'trusted_config_paths = ["/vercel/sandbox/repositories"]',
  "auto_install = true",
  "not_found_auto_install = true",
];

function npmInstall(root: string, packageSpec: string): string {
  return `npm install --prefix ${root} --ignore-scripts --no-audit --no-fund --no-package-lock --no-save ${packageSpec}`;
}

// Installs what prepareDaytonaSandbox and the automation harnesses otherwise
// install at the start of every run.
function harnessInstallCommands(): string[] {
  const codexRoot = `${prebuiltHarnessRoot}/codex/${codexCliVersion}`;
  const claudeRoot = `${prebuiltHarnessRoot}/claude-agent-sdk/${claudeAgentSdkVersion}`;
  const openCodeRoot = `${prebuiltHarnessRoot}/opencode/${openCodeVersion}`;
  return [
    npmInstall(codexRoot, `@openai/codex@${codexCliVersion}`),
    npmInstall(claudeRoot, `@anthropic-ai/claude-agent-sdk@${claudeAgentSdkVersion}`),
    npmInstall(openCodeRoot, `opencode-ai@${openCodeVersion}`),
    // Scripts stay off for dependencies; this one links the platform binary.
    `node ${openCodeRoot}/node_modules/opencode-ai/postinstall.mjs`,
    `[ "$(${codexRoot}/node_modules/.bin/codex --version)" = "codex-cli ${codexCliVersion}" ]`,
    `[ -f ${claudeRoot}/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs ]`,
    `${openCodeRoot}/node_modules/.bin/opencode --version | grep -Fqx ${openCodeVersion}`,
  ];
}

export function sandboxSnapshotCommands(): string[] {
  return [
    "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq build-essential ca-certificates curl git python3 ripgrep tar unzip xz-utils && rm -rf /var/lib/apt/lists/*",
    [
      `curl -fsSLo /tmp/${nodeArchive} https://nodejs.org/dist/v${nodeVersion}/${nodeArchive}`,
      `echo "${nodeArchiveSha256}  /tmp/${nodeArchive}" | sha256sum -c -`,
      `tar -xJf /tmp/${nodeArchive} -C /usr/local --strip-components=1 --no-same-owner`,
      `rm /tmp/${nodeArchive}`,
      `[ "$(node --version)" = "v${nodeVersion}" ]`,
    ].join(" && "),
    `npm install --global --no-audit --no-fund pnpm@${pnpmVersion}`,
    [
      `curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s bun-v${bunVersion}`,
      `[ "$(bun --version)" = "${bunVersion}" ]`,
    ].join(" && "),
    ...harnessInstallCommands(),
  ];
}

// A shim exists only for a tool mise has installed, and mise's reshim
// deletes the shims that point at its binary for any other tool. These point
// at a second link to it, so they stay until mise installs the tool and
// replaces them with its own.
function miseCommands(): string[] {
  const loginShell = (command: string) => `env PATH='${vercelSandboxPath}' /bin/sh -lc 'cd /tmp && ${command}'`;
  return [
    [
      `curl -fsSLo /tmp/${miseBinary} https://github.com/jdx/mise/releases/download/v${miseVersion}/${miseBinary}`,
      `echo "${miseBinarySha256}  /tmp/${miseBinary}" | sha256sum -c -`,
      `sudo install -m 0755 /tmp/${miseBinary} ${miseBinaryPath}`,
      `rm /tmp/${miseBinary}`,
      `[ "$(mise --version | cut -d " " -f 1)" = "${miseVersion}" ]`,
    ].join(" && "),
    [
      "mkdir -p /home/vercel-sandbox/.config/mise",
      `printf '%s\\n' ${miseConfig.map((line) => `'${line}'`).join(" ")} > /home/vercel-sandbox/.config/mise/config.toml`,
    ].join(" && "),
    [
      "sudo ln -s /usr/local/bin/mise /usr/local/bin/mise-shim",
      `mkdir -p ${miseShims}`,
      `for tool in ${miseShimTools.join(" ")}; do ln -s /usr/local/bin/mise-shim ${miseShims}/$tool; done`,
      "mise reshim",
      `for tool in ${miseShimTools.join(" ")}; do [ -L ${miseShims}/$tool ] || exit 1; done`,
    ].join(" && "),
    // Each session sets PATH and runs its commands in a login shell, which
    // must leave the shims first.
    `[ "$(${loginShell("command -v node")})" = "${miseShims}/node" ]`,
    `${loginShell("node --version")} >/dev/null`,
  ];
}

// Vercel's Node 24 runtime is an Amazon Linux image with no ripgrep package,
// and the commands run as its unprivileged user.
export function vercelSandboxSnapshotCommands(): string[] {
  return [
    `[ "$PATH" = "${vercelSandboxDefaultPath}" ] || { echo "Vercel's default PATH changed: $PATH" >&2; exit 1; }`,
    "sudo dnf install -y -q gcc gcc-c++ git make python3 tar unzip xz",
    [
      `curl -fsSLo /tmp/${ripgrepArchive} https://github.com/BurntSushi/ripgrep/releases/download/${ripgrepVersion}/${ripgrepArchive}`,
      `echo "${ripgrepArchiveSha256}  /tmp/${ripgrepArchive}" | sha256sum -c -`,
      `sudo tar -xzf /tmp/${ripgrepArchive} -C /usr/local/bin --strip-components=1 --no-same-owner ${ripgrepArchive.replace(".tar.gz", "")}/rg`,
      `rm /tmp/${ripgrepArchive}`,
      "rg --version >/dev/null",
    ].join(" && "),
    `npm install --global --no-audit --no-fund pnpm@${pnpmVersion}`,
    [
      `curl -fsSL https://bun.sh/install | sudo BUN_INSTALL=/usr/local bash -s bun-v${bunVersion}`,
      `[ "$(bun --version)" = "${bunVersion}" ]`,
    ].join(" && "),
    `sudo mkdir -p ${prebuiltHarnessRoot} && sudo chown "$(id -u):$(id -g)" ${prebuiltHarnessRoot}`,
    ...harnessInstallCommands(),
    ...miseCommands(),
  ];
}

// Whether the sandbox's image has mise. A cell runs the new code before its
// base snapshot is rebuilt with mise, and a resumed thread keeps the image it
// started with, so the agent is told about mise only when it is there.
export async function sandboxHasMise(session: Pick<SandboxSession, "pathExists">): Promise<boolean> {
  if (sandboxProvider() !== "vercel" || !session.pathExists) return false;
  return session.pathExists(miseBinaryPath).catch(() => false);
}

// Tells the agent how runtime versions are chosen. This is not a runtime
// profile prompt part, whose defaults are stored in the schema, because it
// describes the image rather than the agent's task.
export function sandboxRuntimeInstructions(hasMise: boolean): string[] {
  return hasMise
    ? ["The sandbox installs language runtimes with mise: in a repository, node, python, and similar commands use the version its .nvmrc, .node-version, .python-version, .tool-versions, or mise.toml asks for, and `mise use <tool>@<version>` switches one by writing it to the current directory's mise config."]
    : [];
}

// Changes whenever the image contents change, so a new build never replaces
// a snapshot that running workers still use.
export function sandboxSnapshotName(): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([
      sandboxSnapshotBaseImage,
      sandboxSnapshotCommands(),
      sandboxSnapshotResources,
    ]))
    .digest("hex")
    .slice(0, 12);
  return `responder-sandbox-${digest}`;
}
