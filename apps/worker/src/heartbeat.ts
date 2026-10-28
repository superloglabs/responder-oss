// The worker reports that it is alive to an external dead man's switch, such
// as a healthchecks.io check, which alerts when pings stop. The ping is sent
// from a queued health job after a database query, so it stops when job
// dispatch or database access stops, not only when the process exits.

export const workerHeartbeatIntervalMs = 60_000;
// A health job queued while the worker was stuck does not prove it is alive.
const staleHeartbeatJobMs = 2 * workerHeartbeatIntervalMs;
const heartbeatPingTimeoutMs = 10_000;

export function workerHeartbeatUrl(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = environment.WORKER_HEARTBEAT_URL?.trim();
  if (!configured) return undefined;
  const url = new URL(configured);
  if (url.protocol !== "https:") {
    throw new Error("WORKER_HEARTBEAT_URL must be an HTTPS URL");
  }
  return url.toString();
}

export async function sendWorkerHeartbeat(input: {
  checkDatabase: () => Promise<void>;
  fetch?: typeof fetch;
  now?: Date;
  requestedAt: string;
  url: string | undefined;
}): Promise<"sent" | "skipped"> {
  if (!input.url) return "skipped";
  const now = input.now ?? new Date();
  if (now.getTime() - Date.parse(input.requestedAt) > staleHeartbeatJobMs) {
    return "skipped";
  }
  await input.checkDatabase();
  const response = await (input.fetch ?? fetch)(input.url, {
    method: "POST",
    signal: AbortSignal.timeout(heartbeatPingTimeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Worker heartbeat ping returned ${response.status}`);
  }
  return "sent";
}
