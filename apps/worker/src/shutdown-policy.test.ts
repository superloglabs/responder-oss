import { describe, expect, it } from "vitest";
import {
  legacyHeartbeatHandoffWaitMs,
  workerGracefulShutdownTimeoutMs,
} from "./shutdown-policy.js";

describe("worker shutdown policy", () => {
  it("uses the deployment-provided graceful timeout", () => {
    const environment = {
      WORKER_GRACEFUL_SHUTDOWN_TIMEOUT_MS: "90000",
    };

    expect(workerGracefulShutdownTimeoutMs(environment)).toBe(90_000);
    expect(legacyHeartbeatHandoffWaitMs(environment)).toBe(105_000);
  });

  it("falls back to the safe default for invalid values", () => {
    expect(workerGracefulShutdownTimeoutMs({
      WORKER_GRACEFUL_SHUTDOWN_TIMEOUT_MS: "invalid",
    })).toBe(110_000);
  });
});
