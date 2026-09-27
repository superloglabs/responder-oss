import { describe, expect, it } from "vitest";
import { claudeAgentSdkVersion } from "./claude-automation-harness.js";
import { codexCliVersion } from "./codex-automation-harness.js";
import { openCodeVersion } from "./opencode-automation-harness.js";
import {
  sandboxSnapshotCommands,
  sandboxSnapshotName,
  sandboxSnapshotResources,
} from "./sandbox-snapshot.js";

describe("sandbox snapshot", () => {
  it("installs the pinned harnesses where the harnesses look for them", () => {
    const commands = sandboxSnapshotCommands().join("\n");
    expect(commands).toContain(`/opt/responder/codex/${codexCliVersion} `);
    expect(commands).toContain(`@openai/codex@${codexCliVersion}`);
    expect(commands).toContain(`/opt/responder/claude-agent-sdk/${claudeAgentSdkVersion} `);
    expect(commands).toContain(`/opt/responder/opencode/${openCodeVersion}/node_modules/opencode-ai/postinstall.mjs`);
    expect(commands).toContain("build-essential ca-certificates curl git python3 ripgrep tar unzip xz-utils");
  });

  it("installs a checksum-verified Node.js 24 and pnpm for the repositories", () => {
    const commands = sandboxSnapshotCommands().join("\n");
    expect(commands).toMatch(/sha256sum -c -/u);
    expect(commands).toContain('[ "$(node --version)" = "v24.21.0" ]');
    expect(commands).toContain("pnpm@11.15.0");
  });

  it("names the snapshot after its contents", () => {
    expect(sandboxSnapshotName()).toMatch(/^responder-sandbox-[0-9a-f]{12}$/u);
    expect(sandboxSnapshotName()).toBe(sandboxSnapshotName());
  });

  it("gives sandboxes room to install and test dependencies", () => {
    expect(sandboxSnapshotResources).toEqual({ cpu: 2, disk: 10, memory: 4 });
  });
});
