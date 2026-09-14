import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { getDatabase } from "./client.js";
import {
  createScanInvestigationRequest,
  releaseScanRunLease,
  ScanConfigurationError,
} from "./scans.js";

vi.mock("./client.js", () => ({ getDatabase: vi.fn() }));

function activeRunQuery(rows: unknown[]) {
  const query = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: vi.fn(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  query.from.mockReturnValue(query);
  query.innerJoin.mockReturnValue(query);
  query.where.mockReturnValue(query);
  return query;
}

function configurationQuery(row: Record<string, unknown>) {
  const query = {
    from: vi.fn(),
    leftJoin: vi.fn(),
    where: vi.fn(),
    limit: vi.fn().mockResolvedValue([row]),
  };
  query.from.mockReturnValue(query);
  query.leftJoin.mockReturnValue(query);
  query.where.mockReturnValue(query);
  return query;
}

function slackChannelQuery() {
  const query = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: vi.fn(),
    limit: vi.fn().mockResolvedValue([{
      displayName: "incidents",
      externalId: "C123",
      integrationAccountId: "slack-account",
    }]),
  };
  query.from.mockReturnValue(query);
  query.innerJoin.mockReturnValue(query);
  query.where.mockReturnValue(query);
  return query;
}

describe("scan investigation requests", () => {
  beforeEach(() => vi.clearAllMocks());

  it("captures the scan window, source count, and Slack destination", async () => {
    const select = vi
      .fn()
      .mockReturnValueOnce(activeRunQuery([]))
      .mockReturnValueOnce(configurationQuery({
        agentId: "06060606-0606-4606-8606-060606060606",
        frequencyHours: 6,
        slackChannelResourceId: "07070707-0707-4707-8707-070707070707",
        contextAccountIds: ["account-1", "account-2"],
        contextResourceIds: [],
        repositoryIds: ["repository-1"],
        nextRunAt: null,
        channelName: "incidents",
      }))
      .mockReturnValueOnce(slackChannelQuery());
    vi.mocked(getDatabase).mockReturnValue({ select } as never);
    const scheduledFor = new Date("2026-09-14T09:00:00.000Z");

    const request = await createScanInvestigationRequest({
      organizationId: "organization-1",
      externalEventId: "scan-1",
      scheduledFor,
    });

    expect(request.provider).toBe("scan");
    expect(request.attributes).toMatchObject({
      scanWindowStart: "2026-09-14T03:00:00.000Z",
      scanWindowEnd: scheduledFor.toISOString(),
      slackChannelName: "incidents",
      sourceCount: 3,
    });
  });

  it("accepts resource-scoped context as a scan source", async () => {
    const select = vi
      .fn()
      .mockReturnValueOnce(activeRunQuery([]))
      .mockReturnValueOnce(configurationQuery({
        agentId: "06060606-0606-4606-8606-060606060606",
        frequencyHours: 1,
        slackChannelResourceId: "07070707-0707-4707-8707-070707070707",
        contextAccountIds: [],
        contextResourceIds: ["resource-1"],
        repositoryIds: [],
        nextRunAt: null,
        channelName: "incidents",
      }))
      .mockReturnValueOnce(slackChannelQuery());
    vi.mocked(getDatabase).mockReturnValue({ select } as never);

    const request = await createScanInvestigationRequest({
      organizationId: "organization-1",
      externalEventId: "scan-resource",
    });

    expect(request.attributes?.sourceCount).toBe(1);
  });

  it("does not overlap an active scan", async () => {
    vi.mocked(getDatabase).mockReturnValue({
      select: vi.fn(() => activeRunQuery([{ id: "active-scan" }])),
    } as never);

    await expect(
      createScanInvestigationRequest({
        organizationId: "organization-1",
        externalEventId: "scan-2",
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ScanConfigurationError>>({
        code: "scan_already_running",
      }),
    );
  });
});

describe("scan run leases", () => {
  beforeEach(() => vi.clearAllMocks());

  it("casts the scheduled completion time for PostgreSQL interval arithmetic", async () => {
    const where = vi.fn().mockResolvedValue([]);
    const set = vi.fn((values: Record<string, unknown>) => {
      void values;
      return { where };
    });
    vi.mocked(getDatabase).mockReturnValue({
      update: vi.fn(() => ({ set })),
    } as never);

    await releaseScanRunLease({
      advanceSchedule: true,
      completedAt: new Date("2026-09-14T09:15:00.000Z"),
      leaseId: "06060606-0606-4606-8606-060606060606",
      organizationId: "organization-1",
    });

    const nextRunAt = set.mock.calls[0]![0].nextRunAt;
    const query = new PgDialect().sqlToQuery(nextRunAt as SQL);
    expect(query.sql).toContain("cast($1 as timestamptz)");
  });
});
