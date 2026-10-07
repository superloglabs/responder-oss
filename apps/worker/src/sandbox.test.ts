import type {
  DaytonaSandboxClient,
  DaytonaSandboxSession,
} from "@openai/agents-extensions/sandbox/daytona";
import { describe, expect, it, vi } from "vitest";
import {
  closeDaytonaSandbox,
  configureDaytonaSandboxLifecycle,
  createDaytonaSandboxSession,
  deleteDaytonaSandboxByName,
  type DaytonaCleanupDependencies,
  pauseDaytonaSandbox,
  prepareDaytonaPatchSandbox,
  prepareDaytonaSandbox,
  replaceDaytonaSandboxSecrets,
  resumeDaytonaSandbox,
  sandboxDeletedAfterFailedCreation,
  sandboxesLeftAfterFailedCreation,
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
  it("prepares only git and tar for direct diff publication", async () => {
    const session = {
      execCommand: vi.fn().mockResolvedValue(
        "Chunk ID: abc123\nProcess exited with code 0\nOutput:\n",
      ),
    } as unknown as DaytonaSandboxSession;

    await expect(prepareDaytonaPatchSandbox(session)).resolves.toBeUndefined();
    const command = vi.mocked(session.execCommand).mock.calls[0]?.[0].cmd;
    expect(command).toContain("command -v git");
    expect(command).toContain("command -v tar");
    expect(command).not.toMatch(/(?:node|python|bun|ripgrep|unzip)/i);
  });

  it("ensures investigation tools are installed before the agent starts", async () => {
    const session = {
      execCommand: vi.fn().mockResolvedValue(
        "Chunk ID: abc123\nWall time: 0.0100 seconds\nProcess exited with code 0\nOutput:\n",
      ),
    } as unknown as DaytonaSandboxSession;

    await expect(prepareDaytonaSandbox(session)).resolves.toBeUndefined();
    expect(session.execCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        cmd: expect.stringContaining(
          "command -v curl >/dev/null 2>&1 && command -v git >/dev/null 2>&1 && command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1 && command -v rg >/dev/null 2>&1 && command -v unzip >/dev/null 2>&1 && command -v bun >/dev/null 2>&1",
        ),
      }),
    );
    expect(session.execCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        cmd: expect.stringContaining(
          "install -y -qq curl git nodejs npm python3 ripgrep unzip",
        ),
      }),
    );
    expect(session.execCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        cmd: expect.stringContaining(
          "curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash",
        ),
      }),
    );
  });

  it("reports sandbox preparation command failures", async () => {
    const session = {
      execCommand: vi.fn().mockResolvedValue(
        "Chunk ID: abc123\nProcess exited with code 1\nOutput:\npython3 unavailable\n",
      ),
    } as unknown as DaytonaSandboxSession;

    await expect(prepareDaytonaSandbox(session)).rejects.toThrow(
      "Unable to install curl, git, Node.js, npm, Python 3, ripgrep, unzip, and Bun in Daytona: python3 unavailable",
    );
  });

  it("rejects sandbox output without a successful exit marker", async () => {
    const session = {
      execCommand: vi.fn().mockResolvedValue("unexpected output"),
    } as unknown as DaytonaSandboxSession;

    await expect(prepareDaytonaSandbox(session)).rejects.toThrow(
      "Unable to install curl, git, Node.js, npm, Python 3, ripgrep, unzip, and Bun in Daytona",
    );
  });
});

describe("Daytona sandbox cleanup", () => {
  it("removes an existing named sandbox before creating a replacement", async () => {
    const harness = cleanupHarness();
    const createdSession = { state: { sandboxId: "sandbox-2" } };
    const creator = {
      create: vi.fn().mockResolvedValue(createdSession),
    };

    await expect(
      createDaytonaSandboxSession(
        creator,
        { daytonaApiKey: "daytona-test" },
        "responder-investigation-1",
        harness.dependencies,
      ),
    ).resolves.toBe(createdSession);

    expect(harness.get).toHaveBeenCalledWith("responder-investigation-1");
    expect(harness.deleteSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sandbox-1" }),
      60,
      true,
    );
    expect(creator.create).toHaveBeenCalledOnce();
  });

  it("cleans up a sandbox that appears after creation times out", async () => {
    const harness = cleanupHarness({ missing: true });
    const timeout = new Error("sandbox creation timed out");
    const creator = { create: vi.fn().mockRejectedValue(timeout) };
    harness.get
      .mockRejectedValueOnce(
        Object.assign(new Error("missing"), { statusCode: 404 }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error("missing"), { statusCode: 404 }),
      )
      .mockResolvedValueOnce({ id: "sandbox-1" });

    await expect(
      createDaytonaSandboxSession(
        creator,
        { daytonaApiKey: "daytona-test" },
        "responder-investigation-1",
        harness.dependencies,
      ),
    ).rejects.toBe(timeout);

    expect(harness.get).toHaveBeenCalledTimes(3);
    expect(harness.deleteSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sandbox-1" }),
      60,
      true,
    );
    expect(harness.sleep).toHaveBeenCalledWith(500);
  });

  it("creates a replacement under a new name without waiting for the failed sandbox", async () => {
    const harness = cleanupHarness();
    const createdSession = { state: { sandboxId: "sandbox-2" } };
    const startFailure = new Error(
      "DaytonaSandboxClient failed to create sandbox: Sandbox failed to start: Error response from daemon: failed to start shim (status: 400)",
    );
    let firstAttemptFailed = false;
    const creator = {
      create: vi.fn()
        .mockImplementationOnce(async () => {
          firstAttemptFailed = true;
          throw startFailure;
        })
        .mockResolvedValueOnce(createdSession),
    };
    harness.get.mockImplementation(async (name: string) => ({ id: name }));
    // The failed sandbox is still starting and cannot be deleted yet.
    harness.deleteSandbox.mockImplementation(async (sandbox: { id: string }) => {
      if (firstAttemptFailed && sandbox.id === "responder-investigation-1") {
        await new Promise(() => undefined);
      }
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      createDaytonaSandboxSession(
        creator,
        { daytonaApiKey: "daytona-test" },
        "responder-investigation-1",
        harness.dependencies,
      ),
    ).resolves.toBe(createdSession);

    expect(creator.create.mock.calls).toEqual([
      [{ options: { createTimeoutSec: 120, name: "responder-investigation-1" } }],
      [{ options: { createTimeoutSec: 120, name: "responder-investigation-1-2" } }],
    ]);
    expect(harness.sleep).toHaveBeenCalledWith(5_000);
    expect(harness.reportException).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("daytona_sandbox_create_retry"),
    );
    consoleError.mockRestore();
  });

  it("creates a replacement after Daytona times out starting a sandbox", async () => {
    const harness = cleanupHarness();
    const createdSession = { state: { sandboxId: "sandbox-2" } };
    const timeout = Object.assign(
      new Error(
        "DaytonaSandboxClient failed to create sandbox: Failed to create and start sandbox within 120 seconds. Operation timed out.",
      ),
      { details: { errorName: "DaytonaTimeoutError" } },
    );
    const creator = {
      create: vi.fn()
        .mockRejectedValueOnce(timeout)
        .mockResolvedValueOnce(createdSession),
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      createDaytonaSandboxSession(
        creator,
        { daytonaApiKey: "daytona-test" },
        "responder-automation-run-1",
        harness.dependencies,
      ),
    ).resolves.toBe(createdSession);

    expect(creator.create).toHaveBeenCalledTimes(2);
    consoleError.mockRestore();
  });

  it("reports a failed sandbox it could not delete without failing the job", async () => {
    const harness = cleanupHarness();
    const createdSession = { state: { sandboxId: "sandbox-2" } };
    const startFailure = new Error(
      "DaytonaSandboxClient failed to create sandbox: Sandbox failed to start (status: 400)",
    );
    const deleteError = new Error("delete rejected");
    let firstAttemptFailed = false;
    const setAutoDeleteInterval = vi.fn().mockResolvedValue(undefined);
    const creator = {
      create: vi.fn()
        .mockImplementationOnce(async () => {
          firstAttemptFailed = true;
          throw startFailure;
        })
        .mockResolvedValueOnce(createdSession),
    };
    harness.get.mockImplementation(async (name: string) => ({
      id: name,
      setAutoDeleteInterval,
    }));
    harness.deleteSandbox.mockImplementation(async (sandbox: { id: string }) => {
      if (firstAttemptFailed && sandbox.id === "responder-investigation-1") {
        throw deleteError;
      }
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      createDaytonaSandboxSession(
        creator,
        { daytonaApiKey: "daytona-test" },
        "responder-investigation-1",
        harness.dependencies,
      ),
    ).resolves.toBe(createdSession);
    await vi.waitFor(() => {
      expect(harness.reportException).toHaveBeenCalledWith(deleteError, {
        operation: "sandbox_cleanup",
        sandboxId: "responder-investigation-1",
      });
    });

    // Daytona deletes the sandbox once it stops.
    expect(setAutoDeleteInterval).toHaveBeenCalledWith(0);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("daytona_abandoned_sandbox_cleanup_failed"),
    );
    consoleError.mockRestore();
  });

  it("stops after three failed attempts", async () => {
    const harness = cleanupHarness();
    const startFailure = new Error(
      "DaytonaSandboxClient failed to create sandbox: Sandbox failed to start (status: 400)",
    );
    const creator = { create: vi.fn().mockRejectedValue(startFailure) };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      createDaytonaSandboxSession(
        creator,
        { daytonaApiKey: "daytona-test" },
        "responder-investigation-1",
        harness.dependencies,
      ),
    ).rejects.toBe(startFailure);

    expect(creator.create).toHaveBeenCalledTimes(3);
    expect(creator.create).toHaveBeenLastCalledWith({
      options: { createTimeoutSec: 120, name: "responder-investigation-1-3" },
    });
    expect(sandboxDeletedAfterFailedCreation(startFailure)).toBe(true);
    consoleError.mockRestore();
  });

  it("deletes a sandbox created after the caller aborted", async () => {
    const harness = cleanupHarness();
    const controller = new AbortController();
    const reason = new Error("runtime limit reached");
    const creator = {
      create: vi.fn(async () => {
        controller.abort(reason);
        return { state: { sandboxId: "sandbox-1" } } as DaytonaSandboxSession;
      }),
    };

    await expect(
      createDaytonaSandboxSession(
        creator,
        { daytonaApiKey: "daytona-test" },
        "responder-investigation-1",
        harness.dependencies,
        controller.signal,
      ),
    ).rejects.toBe(reason);

    // Once before creation, then once for the sandbox nobody will use.
    expect(harness.deleteSandbox).toHaveBeenCalledTimes(2);
  });

  it("does not create a sandbox when the caller aborts during the first deletion", async () => {
    const harness = cleanupHarness();
    const controller = new AbortController();
    const reason = new Error("runtime limit reached");
    harness.deleteSandbox.mockImplementation(async () => {
      controller.abort(reason);
    });
    const creator = { create: vi.fn() };

    await expect(
      createDaytonaSandboxSession(
        creator,
        { daytonaApiKey: "daytona-test" },
        "responder-investigation-1",
        harness.dependencies,
        controller.signal,
      ),
    ).rejects.toBe(reason);

    expect(creator.create).not.toHaveBeenCalled();
    expect(sandboxDeletedAfterFailedCreation(reason)).toBe(true);
  });

  it("names every failed sandbox it could not delete", async () => {
    const harness = cleanupHarness();
    const startFailure = new Error(
      "DaytonaSandboxClient failed to create sandbox: Sandbox failed to start (status: 400)",
    );
    const deleteError = new Error("delete rejected");
    const failedNames = new Set<string>();
    const creator = {
      create: vi.fn(async (args: { options: { name: string } }) => {
        failedNames.add(args.options.name);
        throw startFailure;
      }),
    };
    harness.get.mockImplementation(async (name: string) => ({ id: name }));
    harness.deleteSandbox.mockImplementation(async (sandbox: { id: string }) => {
      if (failedNames.has(sandbox.id) && sandbox.id !== "responder-investigation-1") {
        throw deleteError;
      }
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const failure = await createDaytonaSandboxSession(
      creator,
      { daytonaApiKey: "daytona-test" },
      "responder-investigation-1",
      harness.dependencies,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(sandboxesLeftAfterFailedCreation(failure)).toEqual([
      "responder-investigation-1-2",
      "responder-investigation-1-3",
    ]);
    consoleError.mockRestore();
  });

  it("rejects sandbox names without room for a replacement suffix", async () => {
    const creator = { create: vi.fn() };

    await expect(
      createDaytonaSandboxSession(
        creator,
        { daytonaApiKey: "daytona-test" },
        "a".repeat(63),
        cleanupHarness().dependencies,
      ),
    ).rejects.toThrow("is too long");
    expect(creator.create).not.toHaveBeenCalled();
  });

  it("marks a creation failure once its sandbox is deleted", async () => {
    const harness = cleanupHarness();
    const createError = new Error("sandbox creation timed out");
    const creator = { create: vi.fn().mockRejectedValue(createError) };

    await expect(
      createDaytonaSandboxSession(
        creator,
        { daytonaApiKey: "daytona-test" },
        "responder-investigation-1",
        harness.dependencies,
      ),
    ).rejects.toBe(createError);

    expect(sandboxDeletedAfterFailedCreation(createError)).toBe(true);
  });

  it("does not mark failures whose sandbox deletion was not confirmed", async () => {
    const creator = {
      create: vi.fn().mockRejectedValue(new Error("sandbox creation timed out")),
    };
    const initialDeleteError = new Error("delete failed before creation");
    const failedBeforeCreation = await createDaytonaSandboxSession(
      creator,
      { daytonaApiKey: "daytona-test" },
      "responder-investigation-1",
      cleanupHarness({ deleteError: initialDeleteError }).dependencies,
    ).catch((error: unknown) => error);
    const failedCleanup = await createDaytonaSandboxSession(
      creator,
      { daytonaApiKey: "daytona-test" },
      "responder-investigation-1",
      cleanupHarness({ missing: true }).dependencies,
    ).catch((error: unknown) => error);

    expect(failedBeforeCreation).toBeInstanceOf(AggregateError);
    expect((failedBeforeCreation as AggregateError).errors[0]).toBe(
      initialDeleteError,
    );
    expect(sandboxDeletedAfterFailedCreation(failedBeforeCreation)).toBe(false);
    expect(failedCleanup).toBeInstanceOf(AggregateError);
    expect(sandboxDeletedAfterFailedCreation(failedCleanup)).toBe(false);
    expect(creator.create).toHaveBeenCalledOnce();
  });

  it("does not create a replacement after the caller aborts", async () => {
    const harness = cleanupHarness();
    const controller = new AbortController();
    const startFailure = new Error(
      "DaytonaSandboxClient failed to create sandbox: Sandbox failed to start (status: 400)",
    );
    const creator = { create: vi.fn().mockRejectedValue(startFailure) };
    harness.sleep.mockImplementation(async () => {
      controller.abort();
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      createDaytonaSandboxSession(
        creator,
        { daytonaApiKey: "daytona-test" },
        "responder-investigation-1",
        harness.dependencies,
        controller.signal,
      ),
    ).rejects.toBe(startFailure);

    expect(creator.create).toHaveBeenCalledOnce();
    expect(sandboxDeletedAfterFailedCreation(startFailure)).toBe(true);
    consoleError.mockRestore();
  });

  it("does not repeat other creation failures", async () => {
    const harness = cleanupHarness();
    const quotaError = new Error("Sandbox quota exceeded");
    const creator = { create: vi.fn().mockRejectedValue(quotaError) };

    await expect(
      createDaytonaSandboxSession(
        creator,
        { daytonaApiKey: "daytona-test" },
        "responder-investigation-1",
        harness.dependencies,
      ),
    ).rejects.toBe(quotaError);

    expect(creator.create).toHaveBeenCalledOnce();
  });

  it("reports when a pending sandbox never appears for deletion", async () => {
    const harness = cleanupHarness({ missing: true });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      deleteDaytonaSandboxByName(
        "responder-automation-run-1",
        { daytonaApiKey: "daytona-test" },
        harness.dependencies,
      ),
    ).rejects.toThrow("did not appear before cleanup timed out");

    expect(harness.get).toHaveBeenCalledTimes(7);
    expect(harness.sleep).toHaveBeenCalledWith(10_000);
    expect(harness.reportException).toHaveBeenCalledWith(
      expect.any(Error),
      {
        operation: "sandbox_cleanup",
        sandboxId: "responder-automation-run-1",
      },
    );
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("daytona_pending_sandbox_not_found"),
    );
    consoleError.mockRestore();
  });

  it("waits for a starting sandbox to accept deletion", async () => {
    const harness = cleanupHarness();
    const conflict = Object.assign(new Error("state change in progress"), {
      name: "DaytonaConflictError",
      statusCode: 409,
    });
    harness.deleteSandbox
      .mockRejectedValueOnce(conflict)
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce(undefined);

    await expect(
      deleteDaytonaSandboxByName(
        "responder-automation-run-1",
        { daytonaApiKey: "daytona-test" },
        harness.dependencies,
      ),
    ).resolves.toBeUndefined();

    expect(harness.deleteSandbox).toHaveBeenCalledTimes(3);
  });

  it("keeps retrying transient deletion failures for the whole wait", async () => {
    const harness = cleanupHarness();
    const unavailable = Object.assign(new Error("unavailable"), {
      statusCode: 503,
    });
    harness.deleteSandbox.mockRejectedValue(unavailable);

    await expect(
      deleteDaytonaSandboxByName(
        "responder-automation-run-1",
        { daytonaApiKey: "daytona-test" },
        harness.dependencies,
      ),
    ).rejects.toBe(unavailable);

    expect(harness.deleteSandbox).toHaveBeenCalledTimes(11);
    expect(harness.sleep).toHaveBeenCalledWith(60_000);
  });

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

  it("replaces a sandbox's secrets, detaching all when none remain, and restarts it", async () => {
    const harness = cleanupHarness();
    const sandbox = {
      id: "sandbox-1",
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      updateSecrets: vi.fn().mockResolvedValue(undefined),
    };
    harness.get.mockResolvedValue(sandbox);

    await replaceDaytonaSandboxSecrets(
      harness.session,
      { daytonaApiKey: "daytona-test" },
      [{ daytonaSecretName: "dtn_billing", environmentVariable: "BILLING_API_KEY" }],
      harness.dependencies,
    );
    await replaceDaytonaSandboxSecrets(harness.session, { daytonaApiKey: "daytona-test" }, [], harness.dependencies);

    expect(sandbox.updateSecrets.mock.calls).toEqual([[{ BILLING_API_KEY: "dtn_billing" }], [{}]]);
    expect(sandbox.stop).toHaveBeenCalledTimes(2);
    expect(sandbox.start).toHaveBeenCalledTimes(2);
    expect(harness.dispose).toHaveBeenCalledTimes(2);
  });

  it("keeps a thread sandbox after it pauses", async () => {
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
      -1,
      harness.dependencies,
    );

    expect(setAutoDeleteInterval).toHaveBeenCalledWith(-1);
  });

  it("retries transient lifecycle failures", async () => {
    const harness = cleanupHarness();
    const gatewayError = Object.assign(new Error("bad gateway"), {
      name: "DaytonaBadGatewayError",
      statusCode: 502,
    });
    const setAutoDeleteInterval = vi
      .fn()
      .mockRejectedValueOnce(gatewayError)
      .mockResolvedValue(undefined);
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

    expect(setAutoDeleteInterval).toHaveBeenCalledTimes(2);
    expect(harness.sleep).toHaveBeenCalledWith(500);
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

describe("Daytona sandbox resume", () => {
  it("gives the resumed session the API key its saved state left out", async () => {
    const session = { state: { sandboxId: "sandbox-1" } };
    const client = {
      deserializeSessionState: vi.fn(async (state: Record<string, unknown>) => ({
        ...state,
        apiKey: undefined,
      })),
      resume: vi.fn().mockResolvedValue(session),
    };

    await expect(
      resumeDaytonaSandbox(
        client as unknown as DaytonaSandboxClient,
        { sandboxId: "sandbox-1" },
        { daytonaApiKey: "daytona-key" },
      ),
    ).resolves.toBe(session);
    expect(client.resume).toHaveBeenCalledWith({
      apiKey: "daytona-key",
      sandboxId: "sandbox-1",
    });
  });
});

describe("Daytona thread sandbox pause", () => {
  it("stops the sandbox through the session", async () => {
    const harness = cleanupHarness();

    await pauseDaytonaSandbox(
      harness.session,
      { investigationId: "investigation-1" },
      harness.dependencies,
    );

    expect(harness.session.close).toHaveBeenCalledOnce();
    expect(harness.reportException).not.toHaveBeenCalled();
  });

  it("reports a failed stop without failing the turn", async () => {
    const stopError = new Error("Sandbox is not in a stoppable state");
    const harness = cleanupHarness({ closeError: stopError });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      pauseDaytonaSandbox(
        harness.session,
        { investigationId: "investigation-1", organizationId: "org-1" },
        harness.dependencies,
      ),
    ).resolves.toBeUndefined();

    expect(harness.reportException).toHaveBeenCalledWith(stopError, {
      investigationId: "investigation-1",
      operation: "sandbox_cleanup",
      organizationId: "org-1",
      sandboxId: "sandbox-1",
    });
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("daytona_sandbox_pause_failed"),
    );
    consoleError.mockRestore();
  });
});
