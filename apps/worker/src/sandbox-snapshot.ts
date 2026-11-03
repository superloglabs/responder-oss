import { createHash } from "node:crypto";
import { prebuiltHarnessRoot } from "./automation-harness.js";
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

// Vercel's Node 24 runtime is an Amazon Linux image with no ripgrep package,
// and the commands run as its unprivileged user.
export function vercelSandboxSnapshotCommands(): string[] {
  return [
    "sudo dnf install -y -q gcc gcc-c++ make tar xz",
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
  ];
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
