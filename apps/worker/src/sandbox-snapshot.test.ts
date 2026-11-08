import { describe, expect, it } from "vitest";
import { claudeAgentSdkVersion } from "./claude-automation-harness.js";
import { codexCliVersion } from "./codex-automation-harness.js";
import { openCodeVersion } from "./opencode-automation-harness.js";
import {
  sandboxSnapshotCommands,
  sandboxSnapshotName,
  sandboxSnapshotResources,
  vercelSandboxDefaultPath,
  vercelSandboxPath,
  vercelSandboxSnapshotCommands,
} from "./sandbox-snapshot.js";

const shims = "/home/vercel-sandbox/.local/share/mise/shims";

describe("sandbox snapshot", () => {
  it("installs the pinned harnesses where the harnesses look for them", () => {
    const commands = sandboxSnapshotCommands().join("\n");
    expect(commands).toContain(`/opt/responder/codex/${codexCliVersion} `);
    expect(commands).toContain(`@openai/codex@${codexCliVersion}`);
    expect(commands).toContain(`/opt/responder/claude-agent-sdk/${claudeAgentSdkVersion} `);
    expect(commands).toContain(`/opt/responder/opencode/${openCodeVersion}/node_modules/opencode-ai/postinstall.mjs`);
    expect(commands).toContain("build-essential ca-certificates curl git python3 ripgrep tar unzip xz-utils");
  });

  it("installs a checksum-verified Node.js 24, pnpm, and Bun for the repositories", () => {
    const commands = sandboxSnapshotCommands().join("\n");
    expect(commands).toMatch(/sha256sum -c -/u);
    expect(commands).toContain('[ "$(node --version)" = "v24.22.1" ]');
    expect(commands).toContain("BUN_INSTALL=/usr/local bash -s bun-v1.4.4");
    expect(commands).toContain('[ "$(bun --version)" = "1.4.4" ]');
    expect(commands).toContain("pnpm@11.15.0");
  });

  it("leaves the Daytona image without mise", () => {
    expect(sandboxSnapshotCommands().join("\n")).not.toContain("mise");
  });

  it("names the snapshot after its contents", () => {
    expect(sandboxSnapshotName()).toMatch(/^responder-sandbox-[0-9a-f]{12}$/u);
    expect(sandboxSnapshotName()).toBe(sandboxSnapshotName());
  });

  it("gives sandboxes room to install and test dependencies", () => {
    expect(sandboxSnapshotResources).toEqual({ cpu: 2, disk: 10, memory: 4 });
  });
});

describe("Vercel sandbox snapshot", () => {
  it("fails the build when Vercel changes the default PATH", () => {
    expect(vercelSandboxDefaultPath).toBe(
      "/vercel/runtimes/node24/bin:/home/vercel-sandbox/.global/pnpm/bin:/home/vercel-sandbox/.global/npm/bin:/vercel/runtimes/node24/bin:/vercel/bin:/opt/git/bin:/home/vercel-sandbox/.local/bin:/usr/local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    );
    expect(vercelSandboxSnapshotCommands()[0]).toContain(`[ "$PATH" = "${vercelSandboxDefaultPath}" ]`);
  });

  it("puts mise's shims before the default PATH", () => {
    expect(vercelSandboxPath).toBe(`${shims}:${vercelSandboxDefaultPath}`);
  });

  it("installs a pinned, checksum-verified mise", () => {
    const commands = vercelSandboxSnapshotCommands().join("\n");
    expect(commands).toContain(
      "https://github.com/jdx/mise/releases/download/v2026.11.4/mise-v2026.11.4-linux-x64",
    );
    expect(commands).toContain(
      'echo "0296d9cba9324106d4e0962bb94a2072902f3658813aeb3b09504947bb8ddc2b  /tmp/mise-v2026.11.4-linux-x64" | sha256sum -c -',
    );
    expect(commands).toContain("sudo install -m 0755 /tmp/mise-v2026.11.4-linux-x64 /usr/local/bin/mise");
    expect(commands).toContain('[ "$(mise --version | cut -d " " -f 1)" = "2026.11.4" ]');
  });

  it("reads version files and installs missing versions without prompts", () => {
    const commands = vercelSandboxSnapshotCommands().join("\n");
    expect(commands).toContain("/home/vercel-sandbox/.config/mise/config.toml");
    expect(commands).toContain("'idiomatic_version_file_enable_tools = [\"go\", \"node\", \"python\", \"ruby\"]'");
    expect(commands).toContain("'trusted_config_paths = [\"/vercel/sandbox/repositories\"]'");
    expect(commands).toContain("'auto_install = true'");
    expect(commands).toContain("'not_found_auto_install = true'");
  });

  it("creates shims that mise keeps before any version is installed", () => {
    const tools = "node npm npx corepack python python3 pip pip3 ruby gem bundle go";
    expect(vercelSandboxSnapshotCommands().join("\n")).toContain([
      "sudo ln -s /usr/local/bin/mise /usr/local/bin/mise-shim",
      `mkdir -p ${shims}`,
      `for tool in ${tools}; do ln -s /usr/local/bin/mise-shim ${shims}/$tool; done`,
      "mise reshim",
      `for tool in ${tools}; do [ -L ${shims}/$tool ] || exit 1; done`,
    ].join(" && "));
  });

  it("checks that a login shell keeps the shims first", () => {
    const commands = vercelSandboxSnapshotCommands().join("\n");
    expect(commands).toContain(
      `[ "$(env PATH='${vercelSandboxPath}' /bin/sh -lc 'cd /tmp && command -v node')" = "${shims}/node" ]`,
    );
    expect(commands).toContain(`env PATH='${vercelSandboxPath}' /bin/sh -lc 'cd /tmp && node --version'`);
  });
});
