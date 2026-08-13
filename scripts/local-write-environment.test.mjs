import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "responder-environment-"));
  temporaryDirectories.push(directory);
  return directory;
}

function environmentValues(contents) {
  return new Map(
    contents
      .split("\n")
      .map((line) => line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/))
      .filter(Boolean)
      .map((match) => [match[1], match[2]]),
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("local environment generation", () => {
  it("repairs copied workspace settings while preserving developer secrets", () => {
    const directory = temporaryDirectory();
    const environmentFile = join(directory, ".env.local");
    const workspace = join(directory, "buffalo");
    writeFileSync(
      environmentFile,
      [
        "RESPONDER_WORKSPACE_PATH=/another/worktree",
        "COMPOSE_PROJECT_NAME=responder-other",
        "CONTROL_PLANE_WEB_PORT=3000",
        "AGENT_PORT=9999",
        "AGENT_URL=http://127.0.0.1:9999",
        "BETTER_AUTH_SECRET=keep-this-secret",
        "AI_GATEWAY_API_KEY=keep-this-key",
        "CUSTOM_LOCAL_VALUE=preserved",
        "",
      ].join("\n"),
    );

    execFileSync(
      process.execPath,
      [
        "scripts/local-write-environment.mjs",
        environmentFile,
        workspace,
        "22000",
      ],
      { cwd: process.cwd() },
    );

    const values = environmentValues(readFileSync(environmentFile, "utf8"));
    expect(values.get("RESPONDER_WORKSPACE_PATH")).toBe(workspace);
    expect(values.get("RESPONDER_PORTLESS_NAME")).toBe("responder.buffalo");
    expect(values.get("COMPOSE_PROJECT_NAME")).toBe("responder-buffalo");
    expect(values.get("CONTROL_PLANE_WEB_PORT")).toBe("22000");
    expect(values.get("CONTROL_PLANE_API_PORT")).toBe("22001");
    expect(values.has("AGENT_PORT")).toBe(false);
    expect(values.has("AGENT_URL")).toBe(false);
    expect(values.get("LOCAL_DATABASE_PORT")).toBe("22003");
    expect(values.get("BETTER_AUTH_SECRET")).toBe("keep-this-secret");
    expect(values.get("AI_GATEWAY_API_KEY")).toBe("keep-this-key");
    expect(values.get("CUSTOM_LOCAL_VALUE")).toBe("preserved");
    expect(values.get("INTERNAL_INGEST_TOKEN")).toMatch(/^[a-f0-9]{64}$/);
  });
});
