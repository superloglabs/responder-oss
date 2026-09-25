import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  legacyHeartbeatHandoffWaitMs,
  onShutdownSignal,
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

  it("keeps its listener so another library's signal handler does not exit early", () => {
    const target = new EventEmitter();
    const handler = vi.fn();
    const exit = vi.fn();
    onShutdownSignal(handler, target as never);
    // Mirrors the OpenAI Agents SDK, which exits when it is the only listener.
    target.on("SIGTERM", () => {
      if (target.listeners("SIGTERM").length <= 1) exit();
    });

    target.emit("SIGTERM");
    target.emit("SIGINT");

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith("SIGTERM");
    expect(exit).not.toHaveBeenCalled();
  });
});
