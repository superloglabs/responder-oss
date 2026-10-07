import { finishSandboxUsage } from "@responder/core/billing/usage-billing";
import {
  heartbeatSandboxUsage,
  startSandboxUsage,
} from "@responder/core/db/sandbox-usage";
import type { SandboxUsageWorkload } from "@responder/core/db/schema";
import { sandboxSnapshotResources } from "./sandbox-snapshot.js";

// Daytona's default resources for a sandbox created from its base image.
const daytonaDefaultResources = { cpu: 1, disk: 3, memory: 1 };

const heartbeatIntervalMs = 60_000;

export interface SandboxMeter {
  // A waived period is not charged, for work that failed through Responder's
  // fault.
  stop(options?: { waived?: boolean }): Promise<void>;
}

export interface SandboxMeterInput {
  billable: boolean;
  organizationId: string;
  // Sandboxes from the prebuilt snapshot use its resources.
  snapshot: boolean;
  workload: SandboxUsageWorkload;
  workloadId: string;
}

interface SandboxMeterDependencies {
  finish: typeof finishSandboxUsage;
  heartbeat: typeof heartbeatSandboxUsage;
  start: typeof startSandboxUsage;
}

const defaultDependencies: SandboxMeterDependencies = {
  finish: finishSandboxUsage,
  heartbeat: heartbeatSandboxUsage,
  start: startSandboxUsage,
};

function logMeterError(event: string, input: SandboxMeterInput, error: unknown): void {
  console.error(JSON.stringify({
    error: error instanceof Error ? error.message : String(error),
    event,
    workload: input.workload,
    workloadId: input.workloadId,
  }));
}

// Records one period of sandbox time, from now until `stop`. Metering never
// fails the sandbox's work: errors are logged, and a period whose stop was
// not recorded is closed at its last heartbeat by the settlement pass.
export function startSandboxMeter(
  input: SandboxMeterInput,
  dependencies: SandboxMeterDependencies = defaultDependencies,
): SandboxMeter {
  const resources = input.snapshot ? sandboxSnapshotResources : daytonaDefaultResources;
  const usageId = dependencies.start({
    billable: input.billable,
    cpu: resources.cpu,
    diskGiB: resources.disk,
    memoryGiB: resources.memory,
    organizationId: input.organizationId,
    workload: input.workload,
    workloadId: input.workloadId,
  }).catch((error: unknown) => {
    logMeterError("sandbox_usage_start_failed", input, error);
    return null;
  });
  const heartbeat = setInterval(() => {
    void usageId.then((id) => id ? dependencies.heartbeat(id) : undefined).catch((error: unknown) => {
      logMeterError("sandbox_usage_heartbeat_failed", input, error);
    });
  }, heartbeatIntervalMs);
  heartbeat.unref();
  let stopped: Promise<void> | undefined;
  return {
    stop(options = {}) {
      stopped ??= (async () => {
        clearInterval(heartbeat);
        const id = await usageId;
        if (!id) return;
        await dependencies.finish(id, options).catch((error: unknown) => {
          logMeterError("sandbox_usage_stop_failed", input, error);
        });
      })();
      return stopped;
    },
  };
}
