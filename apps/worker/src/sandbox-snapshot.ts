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
const nodeVersion = "24.21.0";
const nodeArchive = `node-v${nodeVersion}-linux-x64.tar.xz`;
const nodeArchiveSha256 = "fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6";
const pnpmVersion = "11.15.0";

function npmInstall(root: string, packageSpec: string): string {
  return `npm install --prefix ${root} --ignore-scripts --no-audit --no-fund --no-package-lock --no-save ${packageSpec}`;
}

// Installs what prepareDaytonaSandbox and the automation harnesses otherwise
// install at the start of every run.
export function sandboxSnapshotCommands(): string[] {
  const codexRoot = `${prebuiltHarnessRoot}/codex/${codexCliVersion}`;
  const claudeRoot = `${prebuiltHarnessRoot}/claude-agent-sdk/${claudeAgentSdkVersion}`;
  const openCodeRoot = `${prebuiltHarnessRoot}/opencode/${openCodeVersion}`;
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
    "curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash",
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
