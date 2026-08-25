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
