export const workerGracefulShutdownTimeoutMs = 110_000;

// Allow the old task's graceful stop plus a small scheduling margin before a
// startup migration treats its legacy active job as abandoned.
export const legacyHeartbeatAdoptionGraceMs =
  workerGracefulShutdownTimeoutMs + 15_000;
