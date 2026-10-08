import { afterEach, describe, expect, it, vi } from "vitest";
import {
  disableAgentsWithUnavailableRepositories,
  findAgentsForDash0Alert,
  findAgentsForSentryIssue,
  findAgentsForSlackEvent,
  saveSlackThreadModeConfiguration,
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

  it("sends a direct message to tag mode only", async () => {
    returnAgents([
      {
        accountMetadata: { appId: "A123", botUserId: "U123" },
        agentId: "channel-agent",
        integrationAccountId: "slack-account-1",
        organizationId: "workspace-1",
        purpose: "standard",
        trigger: "slack_mention",
        triggerConfig: { channelIds: [], integrationAccountId: "slack-account-1" },
      },
      {
        accountMetadata: { appId: "A123", botUserId: "U123" },
        agentId: "tag-mode",
        integrationAccountId: "slack-account-1",
        organizationId: "workspace-1",
        purpose: "slack_thread",
        trigger: "slack_mention",
        triggerConfig: {},
      },
    ]);

    await expect(
      findAgentsForSlackEvent({
        channelId: "D123",
        eventType: "direct_message",
        teamId: "T123",
        userId: "U999",
      }),
    ).resolves.toEqual([
      {
        agentId: "tag-mode",
        integrationAccountId: "slack-account-1",
        organizationId: "workspace-1",
        trigger: "slack_thread",
      },
    ]);
  });

  it("does not send a direct message to channel agents when tag mode is off", async () => {
    returnAgents([
      {
        accountMetadata: { appId: "A123", botUserId: "U123" },
        agentId: "channel-agent",
        integrationAccountId: "slack-account-1",
        organizationId: "workspace-1",
        purpose: "standard",
        trigger: "slack_mention",
        triggerConfig: { channelIds: [], integrationAccountId: "slack-account-1" },
      },
    ]);

    await expect(
      findAgentsForSlackEvent({
        channelId: "D123",
        eventType: "direct_message",
        teamId: "T123",
        userId: "U999",
      }),
    ).resolves.toEqual([]);
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

describe("Dash0 alert routing", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("routes alerts only to agents using the addressed account", async () => {
    returnAgents([
      {
        agentId: "agent-1",
        integrationAccountId: "dash0-account-1",
        organizationId: "organization-1",
        trigger: "dash0_alert",
        triggerConfig: { integrationAccountId: "dash0-account-1" },
      },
      {
        agentId: "agent-2",
        integrationAccountId: "dash0-account-1",
        organizationId: "organization-1",
        trigger: "slack_channel",
        triggerConfig: { integrationAccountId: "slack-account-1" },
      },
    ]);

    await expect(findAgentsForDash0Alert("dash0-account-1")).resolves.toEqual([
      { agentId: "agent-1", organizationId: "organization-1" },
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

describe("tag mode saves", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // Each select resolves to the next queued rows.
  function returnSelects(results: unknown[][]) {
    const database = {
      select: vi.fn(() => {
        const rows = results.shift() ?? [];
        const query: Record<string, unknown> = {
          then: (resolve: (value: unknown) => unknown) => resolve(rows),
        };
        for (const method of ["from", "innerJoin", "where", "limit"]) {
          query[method] = vi.fn(() => query);
        }
        return query;
      }),
      transaction: vi.fn(),
    };
    vi.mocked(getDatabase).mockReturnValue(database as never);
    return database;
  }

  const startingTagMode = {
    configuration: {
      contextAccountIds: [],
      contextResourceIds: [],
      enabled: true,
      instructions: "Answer the request.",
      model: "instance/default",
      repositoryIds: [],
      secretIds: [],
    },
    createOnly: true,
    organizationId: "workspace-1",
    userId: "user-1",
  };

  it("leaves saved tag mode alone when only creating it", async () => {
    const database = returnSelects([[{ id: "slack-account" }], [{ id: "tag-mode" }]]);

    await saveSlackThreadModeConfiguration(startingTagMode);

    expect(database.transaction).not.toHaveBeenCalled();
  });

  it("keeps tag mode another save created first", async () => {
    const database = returnSelects([
      [{ id: "slack-account" }],
      [],
      [{ id: "slack-account", metadata: {}, provider: "slack", status: "connected" }],
    ]);
    database.transaction.mockRejectedValue(new Error("Failed query", {
      cause: { code: "23505", constraint: "agents_organization_slack_thread_idx" },
    }));

    await expect(saveSlackThreadModeConfiguration(startingTagMode)).resolves.toBeUndefined();
    expect(database.transaction).toHaveBeenCalledOnce();
  });
});
