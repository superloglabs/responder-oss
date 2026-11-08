import { agentEvents, logWatchSubscribers, notifyLogsMatched } from "@responder/core/agent-events";
import {
  advanceLogWatch,
  claimDueLogWatches,
  endLogWatch,
  logWatchCheckIntervalMs,
  type LogWatch,
} from "@responder/core/db/log-watches";
import { getTelemetryClient, type TelemetryClient } from "@responder/core/telemetry/client";
import { searchTelemetryLogs, TelemetryReadError } from "@responder/core/telemetry/reads";

// Watches claimed per pass, and checked at once. The read-only store limits
// concurrent queries, and the API and alerts share it.
const watchesPerPass = 10;
const concurrentChecks = 2;
// Logs arrive in batches, so a check reads only up to this far behind now.
const ingestLagMs = 30_000;
// One check reads at most this much. A watch that fell behind, after a worker
// restart say, catches up in windows this long, checked one after another.
const maximumWindowMs = 10 * 60_000;
// Matching logs read per check: the count goes up to this, then says "more".
const logsPerCheck = 20;
// A quiet watch asks Wakeshift this often whether anyone still listens.
const subscriberCheckMs = 5 * 60_000;
// A new watch is not ended for having no listener during this time, since
// the tool subscribes its conversation just after creating it.
const startGraceMs = 2 * 60_000;

export interface LogWatchDependencies {
  advance: typeof advanceLogWatch;
  claim: typeof claimDueLogWatches;
  client: () => TelemetryClient | null;
  enabled: () => boolean;
  end: typeof endLogWatch;
  notify: typeof notifyLogsMatched;
  now: () => Date;
  search: typeof searchTelemetryLogs;
  subscribers: typeof logWatchSubscribers;
}

export const defaultLogWatchDependencies: LogWatchDependencies = {
  advance: advanceLogWatch,
  claim: claimDueLogWatches,
  client: getTelemetryClient,
  enabled: () => agentEvents().wake.enabled,
  end: endLogWatch,
  notify: notifyLogsMatched,
  now: () => new Date(),
  search: searchTelemetryLogs,
  subscribers: logWatchSubscribers,
};

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

// Reads the logs that arrived since the watch's last check and wakes its
// conversation with one batch. The cursor moves only once the batch is
// delivered, so a failed query or emit is read again on the next check.
export async function checkLogWatch(
  watch: LogWatch,
  client: TelemetryClient,
  dependencies: LogWatchDependencies,
): Promise<void> {
  const now = dependencies.now();
  const since = watch.checkedThrough;
  const latest = now.getTime() - ingestLagMs;
  const behind = latest - since.getTime() > maximumWindowMs;
  const until = new Date(behind ? since.getTime() + maximumWindowMs : latest);
  // A watch that is behind is checked again at once, until it catches up.
  const nextCheckAt = new Date(now.getTime() + (behind ? 0 : logWatchCheckIntervalMs));
  // Keeps the cursor, and checks the same logs again one interval on.
  const retry = () => dependencies.advance({
    checkedThrough: since, from: since, id: watch.id, nextCheckAt: new Date(now.getTime() + logWatchCheckIntervalMs),
  });
  const advance = (subscribersCheckedAt?: Date) => dependencies.advance({
    checkedThrough: until, from: since, id: watch.id, nextCheckAt,
    ...(subscribersCheckedAt ? { subscribersCheckedAt } : {}),
  });
  if (until <= since) {
    await retry();
    return;
  }
  const started = now.getTime() - watch.createdAt.getTime() >= startGraceMs;

  let logs: Awaited<ReturnType<typeof searchTelemetryLogs>>["logs"];
  try {
    ({ logs } = await dependencies.search(client, watch.organizationId, {
      ...watch.filters,
      limit: logsPerCheck + 1,
      range: "15m",
      since: since.toISOString(),
      until: until.toISOString(),
    }, now));
  } catch (error) {
    if (!(error instanceof TelemetryReadError)) throw error;
    console.warn(JSON.stringify({ error: errorText(error), event: "log_watch_query_failed", watchId: watch.id }));
    await retry();
    return;
  }

  if (logs.length > 0) {
    const newest = logs[0]!;
    const delivered = await dependencies.notify({
      count: Math.min(logs.length, logsPerCheck),
      latest: { body: newest.body || newest.eventName, service: newest.service, severity: newest.severity },
      more: logs.length > logsPerCheck,
      since,
      until,
      watchId: watch.id,
    });
    if (!delivered) {
      await retry();
      return;
    }
    if (delivered.matched === 0 && started) {
      await dependencies.end(watch.id, "unsubscribed", now);
      return;
    }
    await advance(now);
    return;
  }

  const lastAsked = watch.subscribersCheckedAt ?? watch.createdAt;
  if (started && now.getTime() - lastAsked.getTime() >= subscriberCheckMs) {
    const subscribers = await dependencies.subscribers(watch.id);
    if (subscribers === 0) {
      await dependencies.end(watch.id, "unsubscribed", now);
      return;
    }
    await advance(subscribers === null ? undefined : now);
    return;
  }
  await advance();
}

// Checks the watches that are due, a few at a time. Does nothing without
// Wakeshift, since nobody could be woken, or without a telemetry store.
export async function checkDueLogWatches(
  dependencies: LogWatchDependencies = defaultLogWatchDependencies,
): Promise<number> {
  if (!dependencies.enabled()) return 0;
  const client = dependencies.client();
  if (!client) return 0;
  const watches = await dependencies.claim(watchesPerPass, dependencies.now());
  let next = 0;
  const worker = async () => {
    while (next < watches.length) {
      const watch = watches[next]!;
      next += 1;
      await checkLogWatch(watch, client, dependencies).catch((error: unknown) => {
        console.warn(JSON.stringify({ error: errorText(error), event: "log_watch_check_failed", watchId: watch.id }));
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrentChecks, watches.length) }, worker));
  return watches.length;
}
