import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getOrganizationIntegrationAccount,
  updateIntegrationAccountSetup,
} from "../db/integrations.js";
import type { GcpProjectSetupJob } from "../jobs.js";
import { GcpSetupError } from "./gcp-setup.js";
import {
  type GcpSetupState,
  processGcpProjectSetupJob,
} from "./gcp-setup-job.js";

vi.mock("../credentials/encryption.js", () => ({
  decryptCredentials: vi.fn((value: string) =>
    value === "encrypted-token"
      ? { accessToken: "google-token" }
      : {
          projectId: "konex-prod",
          projectNumber: "123456789012",
          sessionName: "responder-gcp-abcdefghijklmnopqrstuvwxyz123456",
        }
  ),
  encryptCredentials: vi.fn(),
}));

vi.mock("../db/integrations.js", () => ({
  getOrganizationIntegrationAccount: vi.fn(),
  updateIntegrationAccountSetup: vi.fn(),
}));

vi.mock("../analytics.js", () => ({ captureAnalyticsEvent: vi.fn() }));

const runId = "40000000-0000-4000-8000-000000000000";
const now = new Date("2026-10-01T16:05:00.000Z");

const job: GcpProjectSetupJob = {
  kind: "gcp_project_setup",
  deadline: "2026-10-01T16:15:00.000Z",
  encryptedAccessToken: "encrypted-token",
  failures: 0,
  integrationAccountId: "30000000-0000-4000-8000-000000000000",
  organizationId: "10000000-0000-4000-8000-000000000000",
  queuedAt: "2026-10-01T16:00:00.000Z",
  runId,
  userId: "20000000-0000-4000-8000-000000000000",
};

let account: {
  encryptedCredentials: string;
  id: string;
  metadata: { setup: GcpSetupState };
  status: string;
};

function runningSetup(): GcpSetupState {
  return {
    runId,
    startedAt: "2026-10-01T16:00:00.000Z",
    status: "running",
    step: "starting",
    updatedAt: "2026-10-01T16:00:00.000Z",
  };
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    advance: vi.fn().mockResolvedValue({ status: "pending", step: "enabling_apis" }),
    enqueue: vi.fn().mockResolvedValue(undefined),
    now: () => now,
    revoke: vi.fn().mockResolvedValue(undefined),
    verify: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("Google Cloud setup job", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    account = {
      encryptedCredentials: "encrypted-connection",
      id: job.integrationAccountId,
      metadata: { setup: runningSetup() },
      status: "pending",
    };
    vi.mocked(getOrganizationIntegrationAccount).mockImplementation(
      async () => structuredClone(account),
    );
    vi.mocked(updateIntegrationAccountSetup).mockImplementation(async (input) => {
      if (input.runId && account.metadata.setup.runId !== input.runId) return false;
      account.metadata.setup = input.setup as GcpSetupState;
      if (input.status) account.status = input.status;
      return true;
    });
  });

  it("records the current step and queues the next round", async () => {
    const deps = dependencies();

    await expect(processGcpProjectSetupJob(job, deps)).resolves.toBe("running");

    expect(deps.advance).toHaveBeenCalledWith({
      accessToken: "google-token",
      connection: expect.objectContaining({ projectId: "konex-prod" }),
    });
    expect(account.metadata.setup).toMatchObject({
      status: "running",
      step: "enabling_apis",
      updatedAt: now.toISOString(),
    });
    expect(deps.enqueue).toHaveBeenCalledWith(
      { ...job, failures: 0, queuedAt: now.toISOString() },
      3,
    );
    expect(deps.revoke).not.toHaveBeenCalled();
  });

  it("connects the project and revokes the token once Google verifies", async () => {
    const deps = dependencies({
      advance: vi.fn().mockResolvedValue({ status: "configured" }),
    });

    await expect(processGcpProjectSetupJob(job, deps)).resolves.toBe("succeeded");

    expect(account.status).toBe("connected");
    expect(account.metadata.setup.status).toBe("succeeded");
    expect(deps.revoke).toHaveBeenCalledWith("google-token");
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it("keeps waiting while Google applies the new access", async () => {
    const deps = dependencies({
      advance: vi.fn().mockResolvedValue({ status: "configured" }),
      verify: vi.fn().mockRejectedValue(new Error("Permission denied")),
    });

    await expect(processGcpProjectSetupJob(job, deps)).resolves.toBe("running");

    expect(account.metadata.setup.step).toBe("waiting_for_google");
    expect(account.status).toBe("pending");
    expect(deps.enqueue).toHaveBeenCalledOnce();
    expect(deps.revoke).not.toHaveBeenCalled();
  });

  it("fails with the reason when the account cannot grant access", async () => {
    const deps = dependencies({
      advance: vi.fn().mockRejectedValue(
        new GcpSetupError("Ask a project Owner to connect it.", "permission_denied"),
      ),
    });

    await expect(processGcpProjectSetupJob(job, deps)).resolves.toBe("failed");

    expect(account.status).toBe("error");
    expect(account.metadata.setup).toMatchObject({
      message: "Ask a project Owner to connect it.",
      status: "failed",
    });
    expect(deps.revoke).toHaveBeenCalledWith("google-token");
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it("leaves a working connection connected when a reconnect fails", async () => {
    account.status = "connected";
    const deps = dependencies({
      advance: vi.fn().mockRejectedValue(
        new GcpSetupError("Ask a project Owner to connect it.", "permission_denied"),
      ),
    });

    await processGcpProjectSetupJob(job, deps);

    expect(account.status).toBe("connected");
    expect(account.metadata.setup.status).toBe("failed");
  });

  it("retries transient Google errors, then gives up", async () => {
    const deps = dependencies({
      advance: vi.fn().mockRejectedValue(new Error("Google Cloud returned HTTP 503")),
    });

    await expect(processGcpProjectSetupJob(job, deps)).resolves.toBe("running");
    expect(deps.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ failures: 1 }),
      3,
    );

    await expect(
      processGcpProjectSetupJob({ ...job, failures: 4 }, deps),
    ).resolves.toBe("failed");
    expect(account.metadata.setup.status).toBe("failed");
    expect(deps.revoke).toHaveBeenCalledOnce();
  });

  it("fails a setup that passes its deadline", async () => {
    const deps = dependencies({
      now: () => new Date("2026-10-01T16:16:00.000Z"),
    });

    await expect(processGcpProjectSetupJob(job, deps)).resolves.toBe("failed");

    expect(deps.advance).not.toHaveBeenCalled();
    expect(account.metadata.setup.message).toMatch(/did not finish/u);
  });

  it("stops a superseded run without touching Google or the newer token", async () => {
    account.metadata.setup = {
      ...runningSetup(),
      runId: "50000000-0000-4000-8000-000000000000",
    };
    const deps = dependencies();

    await expect(processGcpProjectSetupJob(job, deps)).resolves.toBe("superseded");

    expect(deps.advance).not.toHaveBeenCalled();
    expect(deps.revoke).not.toHaveBeenCalled();
    expect(deps.enqueue).not.toHaveBeenCalled();
  });
});
