import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimDueScans,
  createScanInvestigationRequest,
  releaseScanRunLease,
} from "@responder/core/db/scans";
import { queueInvestigation } from "../investigations/queue.js";
import { runDueScans } from "./scheduler.js";

vi.mock("@responder/core/db/scans", () => ({
  claimDueScans: vi.fn(),
  createScanInvestigationRequest: vi.fn(),
  releaseScanRunLease: vi.fn(),
  ScanConfigurationError: class ScanConfigurationError extends Error {
    constructor(message: string, readonly code: string) {
      super(message);
    }
  },
}));
vi.mock("../investigations/queue.js", () => ({ queueInvestigation: vi.fn() }));

const dueScan = {
  frequencyHours: 1,
  leaseId: "06060606-0606-4606-8606-060606060606",
  organizationId: "organization-1",
  scheduledFor: new Date("2026-09-14T08:00:00.000Z"),
  slackChannelResourceId: "07070707-0707-4707-8707-070707070707",
};

describe("scan scheduler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T09:15:00.000Z"));
    vi.mocked(claimDueScans).mockResolvedValue([dueScan]);
    vi.mocked(createScanInvestigationRequest).mockResolvedValue({
      agentId: "agent-1",
      provider: "scan",
      externalEventId: "scan-1",
      title: "Production scan",
      body: "Inspect production.",
    });
  });

  afterEach(() => vi.useRealTimers());

  it("uses the execution time and advances only after queueing", async () => {
    vi.mocked(queueInvestigation).mockResolvedValue({
      investigationId: "investigation-1",
      jobId: "job-1",
      kind: "queued",
    });

    await runDueScans();

    expect(createScanInvestigationRequest).toHaveBeenCalledWith({
      organizationId: dueScan.organizationId,
      scheduledFor: new Date("2026-09-14T09:15:00.000Z"),
      externalEventId: expect.stringContaining(dueScan.leaseId),
    });
    expect(releaseScanRunLease).toHaveBeenCalledWith(expect.objectContaining({
      advanceSchedule: true,
      leaseId: dueScan.leaseId,
    }));
  });

  it("leaves a failed claim due for a real retry", async () => {
    vi.mocked(queueInvestigation).mockRejectedValue(new Error("queue offline"));

    await runDueScans();

    expect(releaseScanRunLease).toHaveBeenCalledWith(expect.objectContaining({
      advanceSchedule: false,
      leaseId: dueScan.leaseId,
    }));
  });
});
