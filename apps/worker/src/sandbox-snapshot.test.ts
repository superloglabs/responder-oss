import { describe, expect, it } from "vitest";
import { claudeAgentSdkVersion } from "./claude-automation-harness.js";
import { codexCliVersion } from "./codex-automation-harness.js";
import { openCodeVersion } from "./opencode-automation-harness.js";
import { sandboxSnapshotCommands, sandboxSnapshotName } from "./sandbox-snapshot.js";

describe("sandbox snapshot", () => {
  it("installs the pinned harnesses where the harnesses look for them", () => {
    const commands = sandboxSnapshotCommands().join("\n");
    expect(commands).toContain(`/opt/responder/codex/${codexCliVersion} `);
    expect(commands).toContain(`@openai/codex@${codexCliVersion}`);
    expect(commands).toContain(`/opt/responder/claude-agent-sdk/${claudeAgentSdkVersion} `);
    expect(commands).toContain(`/opt/responder/opencode/${openCodeVersion}/node_modules/opencode-ai/postinstall.mjs`);
    expect(commands).toContain("git nodejs npm python3 ripgrep tar unzip");
  });

  it("names the snapshot after its contents", () => {
    expect(sandboxSnapshotName()).toMatch(/^responder-sandbox-[0-9a-f]{12}$/u);
    expect(sandboxSnapshotName()).toBe(sandboxSnapshotName());
  });
});
