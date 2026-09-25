const defaultWorkerGracefulShutdownTimeoutMs = 110_000;

export function workerGracefulShutdownTimeoutMs(
  environment: NodeJS.ProcessEnv = process.env,
): number {
  const configured = Number.parseInt(
    environment.WORKER_GRACEFUL_SHUTDOWN_TIMEOUT_MS ?? "",
    10,
  );
  return Number.isFinite(configured) && configured >= 1_000
    ? configured
    : defaultWorkerGracefulShutdownTimeoutMs;
}

// Wait slightly longer than the old task's graceful stop for it to hand active
// jobs back. This never reclassifies active work by itself.
export function legacyHeartbeatHandoffWaitMs(
  environment: NodeJS.ProcessEnv = process.env,
): number {
  return workerGracefulShutdownTimeoutMs(environment) + 15_000;
}

type ShutdownSignal = "SIGINT" | "SIGTERM";

// The listeners stay registered after the first signal. The OpenAI Agents SDK
// calls process.exit from its own listener when no other listener remains,
// which would cut the graceful queue drain short.
export function onShutdownSignal(
  handler: (signal: ShutdownSignal) => void,
  target: Pick<NodeJS.Process, "on"> = process,
): void {
  let received = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    target.on(signal, () => {
      if (received) return;
      received = true;
      handler(signal);
    });
  }
}
