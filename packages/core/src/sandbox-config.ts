import {
  requireDaytonaClientConfig,
  type DaytonaClientConfig,
} from "./daytona-config.js";

export type SandboxProvider = "daytona" | "vercel";

export interface VercelSandboxConfig {
  // Required, because Vercel otherwise runs sandboxes in the US.
  region: string;
  sandboxSnapshotName: string;
  // Set from the workspace's settings. Unset means 2 vCPUs, the size of the
  // snapshot this repository builds.
  vcpus?: number;
  vercel: { projectId: string; teamId: string; token: string };
}

export type SandboxConfig =
  | (DaytonaClientConfig & { vercel?: undefined })
  | VercelSandboxConfig;

// One provider per process. Switching is a restart with a different value, and
// runs paused on the other provider continue in a fresh sandbox.
export function sandboxProvider(
  environment: NodeJS.ProcessEnv = process.env,
): SandboxProvider {
  const provider = environment.SANDBOX_PROVIDER?.trim() || "daytona";
  if (provider !== "daytona" && provider !== "vercel") {
    throw new Error("SANDBOX_PROVIDER must be daytona or vercel");
  }
  return provider;
}

function requireEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function requireSandboxConfig(
  environment: NodeJS.ProcessEnv = process.env,
): SandboxConfig {
  if (sandboxProvider(environment) === "daytona") {
    return requireDaytonaClientConfig(environment);
  }
  return {
    region: requireEnvironmentValue(environment, "VERCEL_SANDBOX_REGION"),
    // The Vercel base image lacks the agents' tools, so a snapshot is required.
    sandboxSnapshotName: requireEnvironmentValue(
      environment,
      "VERCEL_SANDBOX_SNAPSHOT_ID",
    ),
    vercel: {
      projectId: requireEnvironmentValue(environment, "VERCEL_PROJECT_ID"),
      teamId: requireEnvironmentValue(environment, "VERCEL_TEAM_ID"),
      token: requireEnvironmentValue(environment, "VERCEL_TOKEN"),
    },
  };
}

// Vercel requires the workspace to stay under /vercel/sandbox.
export const sandboxHome = sandboxProvider() === "vercel"
  ? "/home/vercel-sandbox"
  : "/home/daytona";
export const sandboxWorkspaceRoot = sandboxProvider() === "vercel"
  ? "/vercel/sandbox"
  : "/home/daytona/workspace";
