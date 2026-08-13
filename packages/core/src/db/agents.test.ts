import { afterEach, describe, expect, it, vi } from "vitest";
import {
  disableAgentsWithUnavailableRepositories,
  findAgentsForSentryIssue,
  findAgentsForSlackEvent,
} from "./agents.js";
import { getDatabase } from "./client.js";

vi.mock("./client.js", () => ({
  getDatabase: vi.fn(),
}));

function returnAgents(rows: unknown[]) {
  const query = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: vi.fn().mockResolvedValue(rows),
  };
  query.from.mockReturnValue(query);
  query.innerJoin.mockReturnValue(query);
  vi.mocked(getDatabase).mockReturnValue({
    select: vi.fn(() => query),
  } as never);
}

describe("Slack event routing", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("sends one channel event to matching agents in several workspaces", async () => {
    returnAgents([
      {
        accountMetadata: { appId: "A123", botUserId: "U123" },
        agentId: "agent-1",
        integrationAccountId: "slack-account-1",
        organizationId: "workspace-1",
        trigger: "slack_channel",
        triggerConfig: {
          channelId: "C123",
          integrationAccountId: "slack-account-1",
        },
      },
      {
        accountMetadata: { appId: "A123", botUserId: "U123" },
        agentId: "agent-2",
        integrationAccountId: "slack-account-2",
        organizationId: "workspace-2",
        trigger: "slack_channel",
        triggerConfig: {
          channelId: "C123",
          integrationAccountId: "slack-account-2",
        },
      },
    ]);

    await expect(
      findAgentsForSlackEvent({
        channelId: "C123",
        eventType: "message",
        teamId: "T123",
      }),
    ).resolves.toEqual([
      {
        agentId: "agent-1",
        integrationAccountId: "slack-account-1",
        organizationId: "workspace-1",
        trigger: "slack_channel",
      },
      {
        agentId: "agent-2",
        integrationAccountId: "slack-account-2",
        organizationId: "workspace-2",
        trigger: "slack_channel",
      },
    ]);
  });
});

describe("Sentry issue routing", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("sends one issue to matching agents in several organizations", async () => {
    returnAgents([
      {
        agentId: "agent-1",
        integrationAccountId: "sentry-account-1",
        organizationId: "organization-1",
        trigger: "sentry_issue",
        triggerConfig: {
          integrationAccountId: "sentry-account-1",
          projectIds: ["project-1"],
        },
      },
      {
        agentId: "agent-2",
        integrationAccountId: "sentry-account-2",
        organizationId: "organization-2",
        trigger: "sentry_issue",
        triggerConfig: {
          integrationAccountId: "sentry-account-2",
          projectIds: ["project-1"],
        },
      },
    ]);

    await expect(
      findAgentsForSentryIssue({
        installationId: "installation-1",
        projectId: "project-1",
      }),
    ).resolves.toEqual([
      { agentId: "agent-1", organizationId: "organization-1" },
      { agentId: "agent-2", organizationId: "organization-2" },
    ]);
  });
});

describe("GitHub repository access", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("disables enabled agents whose active version uses an unavailable repository", async () => {
    const unavailableRepositoryQuery = {
      from: vi.fn(),
      innerJoin: vi.fn(),
      where: vi.fn(),
      limit: vi.fn(),
    };
    unavailableRepositoryQuery.from.mockReturnValue(unavailableRepositoryQuery);
    unavailableRepositoryQuery.innerJoin.mockReturnValue(
      unavailableRepositoryQuery,
    );
    unavailableRepositoryQuery.where.mockReturnValue(
      unavailableRepositoryQuery,
    );
    unavailableRepositoryQuery.limit.mockReturnValue(
      unavailableRepositoryQuery,
    );
    const returning = vi
      .fn()
      .mockResolvedValue([{ id: "agent-1", name: "Production responder" }]);
    const updateWhere = vi.fn(() => ({ returning }));
    const database = {
      select: vi.fn(() => unavailableRepositoryQuery),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: updateWhere })),
      })),
    };
    vi.mocked(getDatabase).mockReturnValue(database as never);

    await expect(
      disableAgentsWithUnavailableRepositories("organization-1"),
    ).resolves.toEqual([
      { id: "agent-1", name: "Production responder" },
    ]);
    expect(database.update).toHaveBeenCalledOnce();
    expect(returning).toHaveBeenCalledOnce();
  });

  it("returns no agents when the atomic update finds no unavailable repositories", async () => {
    const unavailableRepositoryQuery = {
      from: vi.fn(),
      innerJoin: vi.fn(),
      where: vi.fn(),
      limit: vi.fn(),
    };
    unavailableRepositoryQuery.from.mockReturnValue(unavailableRepositoryQuery);
    unavailableRepositoryQuery.innerJoin.mockReturnValue(
      unavailableRepositoryQuery,
    );
    unavailableRepositoryQuery.where.mockReturnValue(
      unavailableRepositoryQuery,
    );
    unavailableRepositoryQuery.limit.mockReturnValue(
      unavailableRepositoryQuery,
    );
    const returning = vi.fn().mockResolvedValue([]);
    const database = {
      select: vi.fn(() => unavailableRepositoryQuery),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({ returning })),
        })),
      })),
    };
    vi.mocked(getDatabase).mockReturnValue(database as never);

    await expect(
      disableAgentsWithUnavailableRepositories("organization-1"),
    ).resolves.toEqual([]);
    expect(database.update).toHaveBeenCalledOnce();
  });
});
