import { afterEach, describe, expect, it, vi } from "vitest";
import type { RemediationJob } from "@responder/core/jobs";
import { processRemediationJob } from "./remediation-job.js";

const payload: RemediationJob = {
  kind: "remediation",
  config: {
    agentId: "13131313-1313-4313-8313-131313131313",
    id: "08080808-0808-4808-8808-080808080808",
    model: "instance/default",
    organizationId: "15151515-1515-4515-8515-151515151515",
    prMode: "manual",
    prompt: "Fix the issue carefully.",
  },
  investigationId: "16161616-1616-4616-8616-161616161616",
  issue: {
    id: "10101010-1010-4010-8010-101010101010",
    title: "Broken route",
    description: "The route throws.",
    severity: "SEV-2",
    remediation: "Handle the missing value.",
    evidence: [],
  },
  queuedAt: "2026-08-17T12:00:00.000Z",
  remediationRequestId: "05050505-0505-4505-8505-050505050505",
  runtimeProfileId: "19191919-1919-4919-8919-191919191919",
};

describe("remediation job terminal state", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records the terminal failure even when monitoring is unavailable", async () => {
    const agentError = new Error("agent failed");
    const diagnostics = {
      applyPatchFailures: [
        {
          callId: "call-1",
          error: "Invalid Context 12",
          operation: "update_file" as const,
          path: "/workspace/repository/src/index.ts",
        },
      ],
      completedTurns: 40,
      maxTurns: 40,
    };
    const failRequest = vi.fn().mockResolvedValue(undefined);
    const reportException = vi.fn(() => {
      throw new Error("monitoring unavailable");
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    await expect(
      processRemediationJob("job-id", payload, {}, {
        failRequest,
        reportException,
        runDiagnostics: vi.fn(() => diagnostics),
        runAgent: vi.fn().mockRejectedValue(agentError),
      }),
    ).resolves.toEqual({ requestId: payload.remediationRequestId });

    expect(failRequest).toHaveBeenCalledWith(
      payload.remediationRequestId,
      "agent failed",
    );
    expect(reportException).toHaveBeenCalledWith(
      agentError,
      expect.objectContaining({
        diagnostics,
        jobId: "job-id",
        requestId: payload.remediationRequestId,
      }),
    );
    expect(consoleError).toHaveBeenCalledWith(
      JSON.stringify({
        diagnostics,
        error: "agent failed",
        event: "remediation_job_failed",
        jobId: "job-id",
        requestId: payload.remediationRequestId,
      }),
    );
    expect(consoleError).toHaveBeenCalledWith(
      JSON.stringify({
        error: "monitoring unavailable",
        event: "remediation_error_reporting_failed",
        jobId: "job-id",
        requestId: payload.remediationRequestId,
      }),
    );
  });

  it("fails the queue job when the terminal database write is unavailable", async () => {
    const databaseError = new Error("database unavailable");
    const reportException = vi.fn().mockResolvedValue(undefined);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    await expect(
      processRemediationJob("job-id", payload, {}, {
        failRequest: vi.fn().mockRejectedValue(databaseError),
        reportException,
        runDiagnostics: vi.fn(() => undefined),
        runAgent: vi.fn().mockRejectedValue(new Error("agent failed")),
      }),
    ).rejects.toThrow("Unable to record remediation failure");

    expect(reportException).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith(
      JSON.stringify({
        error: "database unavailable",
        event: "remediation_failure_recording_failed",
        jobId: "job-id",
        requestId: payload.remediationRequestId,
      }),
    );
  });

  it("records a no-pull-request result without reporting an exception", async () => {
    const failRequest = vi.fn().mockResolvedValue(undefined);
    const reportException = vi.fn();
    vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      processRemediationJob("job-id", payload, {}, {
        failRequest,
        reportException,
        runDiagnostics: vi.fn(() => undefined),
        runAgent: vi.fn().mockResolvedValue("No safe change was available"),
      }),
    ).resolves.toEqual({ requestId: payload.remediationRequestId });

    expect(failRequest).toHaveBeenCalledWith(
      payload.remediationRequestId,
      "Remediation finished without creating a pull request",
    );
    expect(reportException).not.toHaveBeenCalled();
  });

  it("does not let unreadable diagnostics mask a remediation failure", async () => {
    const agentError = new Error("agent failed");
    const failRequest = vi.fn().mockResolvedValue(undefined);
    const reportException = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      processRemediationJob("job-id", payload, {}, {
        failRequest,
        reportException,
        runDiagnostics: vi.fn(() => {
          throw new Error("unreadable diagnostics");
        }),
        runAgent: vi.fn().mockRejectedValue(agentError),
      }),
    ).resolves.toEqual({ requestId: payload.remediationRequestId });

    expect(failRequest).toHaveBeenCalledWith(
      payload.remediationRequestId,
      "agent failed",
    );
    expect(reportException).toHaveBeenCalledOnce();
    expect(reportException.mock.calls[0]?.[1]).not.toHaveProperty("diagnostics");
  });
});
