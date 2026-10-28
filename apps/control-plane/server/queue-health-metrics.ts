import {
  metrics,
  type BatchObservableResult,
  type Meter,
  type ObservableGauge,
} from "@opentelemetry/api";
import type { QueueHealth } from "@responder/core/db/queue-health";

// A collection that cannot read the database records nothing rather than
// holding the metric export open.
const readTimeoutMs = 15_000;

type QueueHealthGauges = {
  finishedRuns: ObservableGauge;
  jobsFailed: ObservableGauge;
  jobsLastCompletedAge: ObservableGauge;
  jobsOldestQueuedAge: ObservableGauge;
  jobsQueued: ObservableGauge;
  leaseExpiredRuns: ObservableGauge;
  oldestPendingRunAge: ObservableGauge;
  orphanedRuns: ObservableGauge;
  pendingRuns: ObservableGauge;
};

function createGauges(meter: Meter): QueueHealthGauges {
  return {
    finishedRuns: meter.createObservableGauge("responder.automation_runs.finished", {
      description: "Automation runs that finished in the last 15 minutes, by status.",
      unit: "{run}",
    }),
    jobsFailed: meter.createObservableGauge("responder.jobs.failed", {
      description: "Jobs that failed after their last retry in the last 15 minutes.",
      unit: "{job}",
    }),
    jobsLastCompletedAge: meter.createObservableGauge("responder.jobs.last_completed.age", {
      description: "Seconds since a job in the queue last completed.",
      unit: "s",
    }),
    jobsOldestQueuedAge: meter.createObservableGauge("responder.jobs.queued.oldest_age", {
      description: "Seconds the oldest job ready to run has waited.",
      unit: "s",
    }),
    jobsQueued: meter.createObservableGauge("responder.jobs.queued", {
      description: "Jobs ready to run that no worker has taken.",
      unit: "{job}",
    }),
    leaseExpiredRuns: meter.createObservableGauge("responder.automation_runs.lease_expired", {
      description: "Running automation runs whose worker stopped renewing the lease.",
      unit: "{run}",
    }),
    oldestPendingRunAge: meter.createObservableGauge("responder.automation_runs.pending.oldest_age", {
      description: "Seconds the oldest pending automation run has waited.",
      unit: "s",
    }),
    orphanedRuns: meter.createObservableGauge("responder.automation_runs.orphaned", {
      description: "Unfinished automation runs with no queued or active job.",
      unit: "{run}",
    }),
    pendingRuns: meter.createObservableGauge("responder.automation_runs.pending", {
      description: "Automation runs waiting for a worker.",
      unit: "{run}",
    }),
  };
}

export function recordQueueHealth(
  result: BatchObservableResult,
  gauges: QueueHealthGauges,
  health: QueueHealth,
): void {
  const runs = health.automationRuns;
  result.observe(gauges.pendingRuns, runs.pending);
  result.observe(gauges.oldestPendingRunAge, runs.oldestPendingSeconds);
  result.observe(gauges.leaseExpiredRuns, runs.leaseExpired);
  result.observe(gauges.orphanedRuns, runs.orphaned);
  for (const status of ["succeeded", "failed", "cancelled"]) {
    result.observe(gauges.finishedRuns, runs.finished[status] ?? 0, {
      "automation_run.status": status,
    });
  }
  for (const job of health.jobs) {
    const attributes = { "messaging.destination.name": job.queue };
    result.observe(gauges.jobsQueued, job.queued, attributes);
    result.observe(gauges.jobsOldestQueuedAge, job.oldestQueuedSeconds, attributes);
    result.observe(gauges.jobsFailed, job.failed, attributes);
    if (job.lastCompletedSeconds !== null) {
      result.observe(gauges.jobsLastCompletedAge, job.lastCompletedSeconds, attributes);
    }
  }
}

// Reports queue health with each metric export. Without a registered meter
// provider the callback never runs.
export function startQueueHealthMetrics(
  read: () => Promise<QueueHealth> = async () => {
    const { readQueueHealth } = await import("@responder/core/db/queue-health");
    return readQueueHealth();
  },
  meter: Meter = metrics.getMeter("responder-control-plane"),
): void {
  const gauges = createGauges(meter);
  meter.addBatchObservableCallback(async (result) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const health = await Promise.race([
        read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Queue health read timed out")), readTimeoutMs);
        }),
      ]);
      recordQueueHealth(result, gauges, health);
    } catch (error) {
      console.error(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          event: "queue_health_read_failed",
        }),
      );
    } finally {
      clearTimeout(timer);
    }
  }, Object.values(gauges));
}
