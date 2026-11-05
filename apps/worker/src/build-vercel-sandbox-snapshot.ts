import { requireSandboxConfig } from "@responder/core/sandbox-config";
import { Sandbox } from "@vercel/sandbox";
import { sandboxSnapshotResources, vercelSandboxSnapshotCommands } from "./sandbox-snapshot.js";
import { runVercelCommand } from "./vercel-sandbox.js";

const buildTimeoutMs = 30 * 60 * 1_000;

// Returns the ID of a new snapshot.
export async function buildVercelSandboxSnapshot(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const config = requireSandboxConfig({
    ...environment,
    VERCEL_SANDBOX_SNAPSHOT_ID: "unused-while-building",
  });
  if (!config.vercel) throw new Error("SANDBOX_PROVIDER must be vercel");
  const sandbox = await Sandbox.create({
    ...config.vercel,
    persistent: false,
    region: config.region,
    resources: { vcpus: sandboxSnapshotResources.cpu },
    runtime: "node24",
    timeout: buildTimeoutMs,
  });
  try {
    for (const command of vercelSandboxSnapshotCommands()) {
      const result = await runVercelCommand(sandbox, {
        args: ["-lc", `set -e; ${command}`],
        cmd: "/bin/sh",
      });
      if (result.exitCode !== 0) {
        throw new Error(`Snapshot command failed: ${command}\n${await result.output("both")}`);
      }
    }
    const snapshot = await sandbox.snapshot({ expiration: 0 });
    return snapshot.snapshotId;
  } catch (error) {
    await sandbox.stop().catch(() => undefined);
    throw error;
  }
}
