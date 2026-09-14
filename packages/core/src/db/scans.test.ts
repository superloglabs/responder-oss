import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDatabase } from "./client.js";
import {
  createScanInvestigationRequest,
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
