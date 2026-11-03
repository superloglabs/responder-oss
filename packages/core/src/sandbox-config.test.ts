import { describe, expect, it } from "vitest";
import { requireSandboxConfig, sandboxProvider } from "./sandbox-config.js";

const vercelEnvironment = {
  SANDBOX_PROVIDER: "vercel",
  VERCEL_PROJECT_ID: "prj_1",
  VERCEL_SANDBOX_REGION: "cdg1",
  VERCEL_SANDBOX_SNAPSHOT_ID: "snap_1",
  VERCEL_TEAM_ID: "team_1",
  VERCEL_TOKEN: "token",
};

describe("sandbox configuration", () => {
  it("defaults to Daytona", () => {
    expect(sandboxProvider({})).toBe("daytona");
    expect(requireSandboxConfig({ DAYTONA_API_KEY: "key" })).toMatchObject({
      daytonaApiKey: "key",
    });
  });

  it("rejects an unknown provider", () => {
    expect(() => sandboxProvider({ SANDBOX_PROVIDER: "e2b" })).toThrow(
      "SANDBOX_PROVIDER must be daytona or vercel",
    );
  });

  it("reads the Vercel settings without a Daytona key", () => {
    expect(requireSandboxConfig(vercelEnvironment)).toEqual({
      region: "cdg1",
      sandboxSnapshotName: "snap_1",
      vercel: { projectId: "prj_1", teamId: "team_1", token: "token" },
    });
  });

  it.each([
    "VERCEL_PROJECT_ID",
    "VERCEL_SANDBOX_REGION",
    "VERCEL_SANDBOX_SNAPSHOT_ID",
    "VERCEL_TEAM_ID",
    "VERCEL_TOKEN",
  ])("requires %s", (name) => {
    expect(() =>
      requireSandboxConfig({ ...vercelEnvironment, [name]: "" })
    ).toThrow(`${name} is required`);
  });
});
