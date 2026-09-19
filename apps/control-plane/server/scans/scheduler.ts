import {
  claimDueScans,
  createScanInvestigationRequest,
  releaseScanRunLease,
  ScanConfigurationError,
} from "@responder/core/db/scans";
import { queueInvestigation } from "../investigations/queue.js";

const pollIntervalMs = 30_000;
let drain: Promise<void> | undefined;
let poller: NodeJS.Timeout | undefined;

export async function runDueScans(): Promise<void> {
  const dueScans = await claimDueScans();
  await Promise.all(
    dueScans.map(async (scan) => {
      let advanceSchedule = false;
      try {
        const executionTime = new Date();
        const request = await createScanInvestigationRequest({
          organizationId: scan.organizationId,
          scheduledFor: executionTime,
          externalEventId: `scheduled:${scan.organizationId}:${scan.scheduledFor.toISOString()}`,
        });
        const result = await queueInvestigation(request, {
          retryFailedDuplicate: true,
        });
        advanceSchedule = true;
        console.info(
          JSON.stringify({
            event: "scheduled_scan_queued",
            investigationId:
              result.kind === "blocked" || result.kind === "paused"
                ? null
                : result.investigationId,
            organizationId: scan.organizationId,
            outcome: result.kind,
            scheduledFor: executionTime.toISOString(),
          }),
        );
      } catch (error) {
        if (
          error instanceof ScanConfigurationError &&
          error.code === "scan_already_running"
        ) {
          advanceSchedule = true;
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
      } finally {
        await releaseScanRunLease({
          organizationId: scan.organizationId,
          leaseId: scan.leaseId,
          completedAt: new Date(),
          advanceSchedule,
        }).catch((releaseError: unknown) => {
          console.error(JSON.stringify({
            error: releaseError instanceof Error
              ? releaseError.message
              : String(releaseError),
            event: "scheduled_scan_lease_release_failed",
            organizationId: scan.organizationId,
          }));
        });
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
