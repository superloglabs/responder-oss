import {
  claimDueScans,
  createScanInvestigationRequest,
  ScanConfigurationError,
} from "@responder/core/db/scans";
import { queueInvestigation } from "../investigations/queue.js";

const pollIntervalMs = 30_000;
let drain: Promise<void> | undefined;
let poller: NodeJS.Timeout | undefined;

async function runDueScans(): Promise<void> {
  const dueScans = await claimDueScans();
  await Promise.all(
    dueScans.map(async (scan) => {
      try {
        const request = await createScanInvestigationRequest({
          organizationId: scan.organizationId,
          scheduledFor: scan.scheduledFor,
          externalEventId: `scheduled:${scan.organizationId}:${scan.scheduledFor.toISOString()}`,
        });
        const result = await queueInvestigation(request);
        console.info(
          JSON.stringify({
            event: "scheduled_scan_queued",
            investigationId:
              result.kind === "blocked" ? null : result.investigationId,
            organizationId: scan.organizationId,
            outcome: result.kind,
            scheduledFor: scan.scheduledFor.toISOString(),
          }),
        );
      } catch (error) {
        if (
          error instanceof ScanConfigurationError &&
          error.code === "scan_already_running"
        ) {
          return;
        }
        console.error(
          JSON.stringify({
            event: "scheduled_scan_failed",
            error: error instanceof Error ? error.message : String(error),
            organizationId: scan.organizationId,
            scheduledFor: scan.scheduledFor.toISOString(),
          }),
        );
      }
    }),
  );
}

function drainDueScans(): Promise<void> {
  if (drain) return drain;
  drain = runDueScans()
    .catch((error: unknown) => {
      console.error(
        JSON.stringify({
          event: "scheduled_scan_drain_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    })
    .finally(() => {
      drain = undefined;
    });
  return drain;
}

export function startScanScheduler(): void {
  if (poller) return;
  void drainDueScans();
  poller = setInterval(() => void drainDueScans(), pollIntervalMs);
  poller.unref();
}

export async function stopScanScheduler(): Promise<void> {
  if (poller) clearInterval(poller);
  poller = undefined;
  await drain;
}
