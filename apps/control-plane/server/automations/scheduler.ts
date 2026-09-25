import { findDueScheduledAutomations, scheduleExternalEventId } from "@responder/core/db/automations";
import { scheduleLabel } from "@responder/core/automations/schedule";
import { queueAutomationRun } from "./queue.js";

const pollIntervalMs = 60_000;
let drain: Promise<void> | undefined;
let poller: NodeJS.Timeout | undefined;

const frequencyTitles = {
  daily: "Daily run",
  hourly: "Hourly run",
  weekly: "Weekly run",
} as const;

// Queues one run for each schedule automation whose latest slot has not run.
// A slot that fails to queue stays due and is retried on the next poll.
export async function runDueScheduledAutomations(now = new Date()): Promise<void> {
  const due = await findDueScheduledAutomations(now);
  await Promise.all(due.map(async ({ automationId, scheduledFor, trigger }) => {
    try {
      const result = await queueAutomationRun({
        automationId,
        trigger: {
          attributes: {
            frequency: trigger.frequency,
            scheduledFor: scheduledFor.toISOString(),
            timezone: trigger.timezone,
          },
          body: `Scheduled run: ${scheduleLabel(trigger)} (${trigger.timezone}). This run is for ${scheduledFor.toISOString()}.`,
          externalEventId: scheduleExternalEventId(scheduledFor),
          provider: "schedule",
          title: frequencyTitles[trigger.frequency],
        },
      });
      console.info(JSON.stringify({
        automationId,
        duplicate: result.duplicate,
        event: "scheduled_automation_queued",
        runId: result.runId,
        scheduledFor: scheduledFor.toISOString(),
      }));
    } catch (error) {
      console.error(JSON.stringify({
        automationId,
        error: error instanceof Error ? error.message : String(error),
        event: "scheduled_automation_failed",
        scheduledFor: scheduledFor.toISOString(),
      }));
    }
  }));
}

function drainDueScheduledAutomations(): Promise<void> {
  if (drain) return drain;
  drain = runDueScheduledAutomations()
    .catch((error: unknown) => {
      console.error(JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        event: "scheduled_automation_drain_failed",
      }));
    })
    .finally(() => {
      drain = undefined;
    });
  return drain;
}

export function startAutomationScheduler(): void {
  if (poller) return;
  void drainDueScheduledAutomations();
  poller = setInterval(() => void drainDueScheduledAutomations(), pollIntervalMs);
  poller.unref();
}

export async function stopAutomationScheduler(): Promise<void> {
  if (poller) clearInterval(poller);
  poller = undefined;
  await drain;
}
