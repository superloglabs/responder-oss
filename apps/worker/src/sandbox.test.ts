import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import { describe, expect, it, vi } from "vitest";
import {
  closeDaytonaSandbox,
  configureDaytonaSandboxLifecycle,
  type DaytonaCleanupDependencies,
  prepareDaytonaSandbox,
} from "./sandbox.js";

function cleanupHarness(options?: {
  closeError?: Error;
  deleteError?: Error;
  missing?: boolean;
}) {
  const session = {
    close: options?.closeError
      ? vi.fn().mockRejectedValue(options.closeError)
      : vi.fn().mockResolvedValue(undefined),
    state: { sandboxId: "sandbox-1" },
  } as unknown as DaytonaSandboxSession;
  const sandbox = { id: "sandbox-1" };
  const get = options?.missing
    ? vi.fn().mockRejectedValue(
        Object.assign(new Error("missing"), { statusCode: 404 }),
      )
    : vi.fn().mockResolvedValue(sandbox);
  const deleteSandbox = options?.deleteError
    ? vi.fn().mockRejectedValue(options.deleteError)
    : vi.fn().mockResolvedValue(undefined);
  const dispose = vi.fn().mockResolvedValue(undefined);
  const reportException = vi.fn().mockResolvedValue(undefined);
  const sleep = vi.fn().mockResolvedValue(undefined);
  const dependencies = {
    createClient: vi.fn(() => ({
      delete: deleteSandbox,
      get,
      [Symbol.asyncDispose]: dispose,
    })),
    reportException,
    sleep,
  } as unknown as DaytonaCleanupDependencies;

  return {
    deleteSandbox,
    dependencies,
    dispose,
    get,
    reportException,
    session,
    sleep,
  };
}

describe("Daytona sandbox preparation", () => {
  it("ensures git and ripgrep are installed before the agent starts", async () => {
    const session = {
      execCommand: vi.fn().mockResolvedValue(
        "Chunk ID: abc123\nWall time: 0.0100 seconds\nProcess exited with code 0\nOutput:\n",
      ),
    } as unknown as DaytonaSandboxSession;

    await expect(prepareDaytonaSandbox(session)).resolves.toBeUndefined();
    expect(session.execCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        cmd: expect.stringContaining("install -y -qq git ripgrep"),
      }),
    );
  });
});

describe("Daytona sandbox cleanup", () => {
  it("enables provider-side deletion when a sandbox stops", async () => {
    const harness = cleanupHarness();
    const setAutoDeleteInterval = vi.fn().mockResolvedValue(undefined);
    harness.get.mockResolvedValue({
      id: "sandbox-1",
      setAutoDeleteInterval,
    });

    await configureDaytonaSandboxLifecycle(
      harness.session,
      { daytonaApiKey: "daytona-test" },
      [],
      harness.dependencies,
    );

    expect(setAutoDeleteInterval).toHaveBeenCalledWith(0);
    expect(harness.dispose).toHaveBeenCalledOnce();
  });

  it("mounts opaque secrets and restarts before enabling stop-time deletion", async () => {
    const harness = cleanupHarness();
    const calls: string[] = [];
    const sandbox = {
      id: "sandbox-1",
      updateSecrets: vi.fn(async () => { calls.push("update"); }),
      stop: vi.fn(async () => { calls.push("stop"); }),
      start: vi.fn(async () => { calls.push("start"); }),
      setAutoDeleteInterval: vi.fn(async () => { calls.push("auto-delete"); }),
    };
    harness.get.mockResolvedValue(sandbox);

    await configureDaytonaSandboxLifecycle(
      harness.session,
      { daytonaApiKey: "daytona-test" },
      [
        {
          environmentVariable: "DAYTONA_API_KEY",
          daytonaSecretName: "responder_secret_1",
        },
      ],
      harness.dependencies,
    );

    expect(sandbox.updateSecrets).toHaveBeenCalledWith({
      DAYTONA_API_KEY: "responder_secret_1",
    });
    expect(calls).toEqual(["update", "stop", "start", "auto-delete"]);
  });

  it("accepts a sandbox already deleted by session close", async () => {
    const harness = cleanupHarness({ missing: true });

    await closeDaytonaSandbox(
      harness.session,
      { daytonaApiKey: "daytona-test" },
      { investigationId: "investigation-1" },
      harness.dependencies,
    );

    expect(harness.session.close).toHaveBeenCalledOnce();
    expect(harness.deleteSandbox).not.toHaveBeenCalled();
    expect(harness.reportException).not.toHaveBeenCalled();
    expect(harness.dispose).toHaveBeenCalledOnce();
  });

  it("falls back to a confirmed provider deletion when session close fails", async () => {
    const harness = cleanupHarness({
      closeError: new Error("session close failed"),
    });

    await closeDaytonaSandbox(
      harness.session,
      { daytonaApiKey: "daytona-test" },
      { investigationId: "investigation-1" },
      harness.dependencies,
    );

    expect(harness.deleteSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sandbox-1" }),
      60,
      true,
    );
    expect(harness.reportException).not.toHaveBeenCalled();
  });

  it("retries and reports cleanup failures without failing the investigation", async () => {
    const harness = cleanupHarness({
      closeError: new Error("session close failed"),
      deleteError: new Error("provider delete failed"),
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      closeDaytonaSandbox(
        harness.session,
        { daytonaApiKey: "daytona-test" },
        { investigationId: "investigation-1" },
        harness.dependencies,
      ),
    ).resolves.toBeUndefined();

    expect(harness.deleteSandbox).toHaveBeenCalledTimes(3);
    expect(harness.sleep).toHaveBeenCalledTimes(2);
    expect(harness.reportException).toHaveBeenCalledWith(
      expect.any(AggregateError),
      expect.objectContaining({
        investigationId: "investigation-1",
        operation: "sandbox_cleanup",
        sandboxId: "sandbox-1",
      }),
    );
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("daytona_sandbox_cleanup_failed"),
    );
    consoleError.mockRestore();
  });
});
