import { and, desc, eq, exists, inArray } from "drizzle-orm";
import type {
  AgentConfiguration,
  SlackThreadModeConfiguration,
} from "../agents/config.js";
import { LINEAR_AUTH_VERSION } from "../integrations/linear.js";
import { getDatabase } from "./client.js";
import {
  agentConfigVersions,
  agents,
  agentVersionRepositories,
  agentVersionSecrets,
  integrationAccounts,
  integrationResources,
  investigations,
  repositories,
  workspaceSecrets,
  type AgentReportConfig,
  type AgentTriggerConfig,
} from "./schema.js";
import { listWorkspaceSecrets } from "./workspace-secrets.js";

type Provider =
  | "github"
  | "slack"
  | "sentry"
  | "datadog"
  | "dash0"
  | "axiom";

export class AgentConfigurationError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "agent_not_found"
      | "integration_not_found"
      | "resource_not_found"
      | "repository_not_found",
  ) {
    super(message);
  }
}

export async function findAgentsForSlackEvent(input: {
  teamId: string;
  channelId: string;
  eventType: "message" | "app_mention";
  userId?: string;
  senderAppId?: string;
}): Promise<
  Array<{
    agentId: string;
    integrationAccountId: string;
    organizationId: string;
    trigger: "slack_channel" | "slack_mention" | "slack_thread";
  }>
> {
  const db = getDatabase();
  const rows = await db
    .select({
      agentId: agents.id,
      organizationId: agents.organizationId,
      integrationAccountId: integrationAccounts.id,
      accountMetadata: integrationAccounts.metadata,
      trigger: agentConfigVersions.trigger,
      triggerConfig: agentConfigVersions.triggerConfig,
      purpose: agents.purpose,
    })
    .from(agents)
    .innerJoin(
      agentConfigVersions,
      eq(agentConfigVersions.id, agents.activeVersionId),
    )
    .innerJoin(
      integrationAccounts,
      and(
        eq(integrationAccounts.organizationId, agents.organizationId),
        eq(integrationAccounts.provider, "slack"),
        eq(integrationAccounts.externalAccountId, input.teamId),
        eq(integrationAccounts.status, "connected"),
      ),
    )
    .where(eq(agents.enabled, true));

  const useSlackThreadMode =
    input.eventType === "app_mention" &&
    rows.some((row) => row.purpose === "slack_thread");

  return rows
    .filter((row) => {
      if (
        (input.userId &&
          row.accountMetadata.botUserId === input.userId) ||
        (input.senderAppId &&
          row.accountMetadata.appId === input.senderAppId)
      ) {
        return false;
      }
      if (row.purpose === "slack_thread") {
        return input.eventType === "app_mention";
      }
      if (useSlackThreadMode) return false;
      if (row.triggerConfig.integrationAccountId !== row.integrationAccountId) return false;
      if (row.trigger === "slack_channel" && input.eventType === "message") {
        return (
          "channelId" in row.triggerConfig &&
          row.triggerConfig.channelId === input.channelId
        );
      }
      if (row.trigger === "slack_mention" && input.eventType === "app_mention") {
        return (
          "channelIds" in row.triggerConfig &&
          (row.triggerConfig.channelIds.length === 0 ||
            row.triggerConfig.channelIds.includes(input.channelId))
        );
      }
      return false;
    })
    .map((row) => ({
      agentId: row.agentId,
      integrationAccountId: row.integrationAccountId,
      organizationId: row.organizationId,
      trigger: row.purpose === "slack_thread"
        ? "slack_thread" as const
        : row.trigger as "slack_channel" | "slack_mention",
    }));
}

export async function findAgentsForSentryIssue(input: {
  installationId: string;
  projectId: string;
}): Promise<Array<{ agentId: string; organizationId: string }>> {
  const rows = await getDatabase()
    .select({
      agentId: agents.id,
      organizationId: agents.organizationId,
      integrationAccountId: integrationAccounts.id,
      trigger: agentConfigVersions.trigger,
      triggerConfig: agentConfigVersions.triggerConfig,
    })
    .from(agents)
    .innerJoin(
      agentConfigVersions,
      eq(agentConfigVersions.id, agents.activeVersionId),
    )
    .innerJoin(
      integrationAccounts,
      and(
        eq(integrationAccounts.organizationId, agents.organizationId),
        eq(integrationAccounts.provider, "sentry"),
        eq(integrationAccounts.externalAccountId, input.installationId),
        eq(integrationAccounts.status, "connected"),
      ),
    )
    .where(eq(agents.enabled, true));

  return rows
    .filter(
      (row) =>
        row.trigger === "sentry_issue" &&
        row.triggerConfig.integrationAccountId === row.integrationAccountId &&
        "projectIds" in row.triggerConfig &&
        row.triggerConfig.projectIds.includes(input.projectId),
    )
    .map((row) => ({
      agentId: row.agentId,
      organizationId: row.organizationId,
    }));
}

export async function findAgentsForDash0Alert(
  integrationAccountId: string,
): Promise<Array<{ agentId: string; organizationId: string }>> {
  const rows = await getDatabase()
    .select({
      agentId: agents.id,
      organizationId: agents.organizationId,
      integrationAccountId: integrationAccounts.id,
      trigger: agentConfigVersions.trigger,
      triggerConfig: agentConfigVersions.triggerConfig,
    })
    .from(agents)
    .innerJoin(
      agentConfigVersions,
      eq(agentConfigVersions.id, agents.activeVersionId),
    )
    .innerJoin(
      integrationAccounts,
      and(
        eq(integrationAccounts.id, integrationAccountId),
        eq(integrationAccounts.organizationId, agents.organizationId),
        eq(integrationAccounts.provider, "dash0"),
        eq(integrationAccounts.status, "connected"),
      ),
    )
    .where(eq(agents.enabled, true));

  return rows
    .filter(
      (row) =>
        row.trigger === "dash0_alert" &&
        row.triggerConfig.integrationAccountId === row.integrationAccountId,
    )
    .map((row) => ({
      agentId: row.agentId,
      organizationId: row.organizationId,
    }));
}

function requiredTriggerProvider(
  trigger: AgentConfiguration["trigger"],
): Provider {
  switch (trigger.kind) {
    case "sentry_issue":
      return "sentry";
    case "datadog_monitor":
      return "datadog";
    case "dash0_alert":
      return "dash0";
    case "slack_channel":
    case "slack_mention":
      return "slack";
  }
}

function triggerResources(trigger: AgentConfiguration["trigger"]): {
  kind: "slack_channel" | "sentry_project" | "datadog_monitor";
  externalIds: string[];
} | null {
  switch (trigger.kind) {
    case "sentry_issue":
      return { kind: "sentry_project", externalIds: trigger.projectIds };
    case "datadog_monitor":
      return { kind: "datadog_monitor", externalIds: trigger.monitorIds };
    case "dash0_alert":
      return null;
    case "slack_channel":
      return { kind: "slack_channel", externalIds: [trigger.channelId] };
    case "slack_mention":
      return { kind: "slack_channel", externalIds: trigger.channelIds };
  }
}

async function validateConfigurationResources(
  organizationId: string,
  configuration: AgentConfiguration,
): Promise<void> {
  const db = getDatabase();
  const requiredAccounts = new Map<string, Provider>([
    [
      configuration.trigger.integrationAccountId,
      requiredTriggerProvider(configuration.trigger),
    ],
  ]);
  if (configuration.reporting.mode !== "thread") {
    requiredAccounts.set(configuration.reporting.integrationAccountId, "slack");
  }

  const contextAccountIds = new Set(configuration.contextAccountIds);
  if (contextAccountIds.size !== configuration.contextAccountIds.length) {
    throw new AgentConfigurationError(
      "Context integrations must be unique",
      "integration_not_found",
    );
  }

  const accountIds = [
    ...new Set([...requiredAccounts.keys(), ...contextAccountIds]),
  ];
  const accountRows = await db
    .select({
      id: integrationAccounts.id,
      metadata: integrationAccounts.metadata,
      provider: integrationAccounts.provider,
      status: integrationAccounts.status,
    })
    .from(integrationAccounts)
    .where(
      and(
        eq(integrationAccounts.organizationId, organizationId),
        inArray(integrationAccounts.id, accountIds),
      ),
    );
  const accountsById = new Map(accountRows.map((account) => [account.id, account]));

  for (const [accountId, provider] of requiredAccounts) {
    const account = accountsById.get(accountId);
    if (
      !account ||
      account.provider !== provider ||
      account.status !== "connected"
    ) {
      throw new AgentConfigurationError(
        `Choose a connected ${provider} account`,
        "integration_not_found",
      );
    }
  }

  for (const accountId of contextAccountIds) {
    const account = accountsById.get(accountId);
    if (
      !account ||
      ![
        "aws",
        "gcp",
        "sentry",
        "datadog",
        "dash0",
        "axiom",
        "clickstack",
        "upstash",
        "langfuse",
        "vercel",
        "custom_mcp",
        "linear",
      ].includes(
        account.provider,
      ) ||
      account.status !== "connected" ||
      (account.provider === "linear" &&
        account.metadata.authVersion !== LINEAR_AUTH_VERSION)
    ) {
      throw new AgentConfigurationError(
        "Choose a connected context integration",
        "integration_not_found",
      );
    }
  }

  const contextResourceIds = new Set(configuration.contextResourceIds);
  if (contextResourceIds.size !== configuration.contextResourceIds.length) {
    throw new AgentConfigurationError(
      "Context resources must be unique",
      "resource_not_found",
    );
  }
  if (contextResourceIds.size > 0) {
    const contextResourceRows = await db
      .select({
        id: integrationResources.id,
        integrationAccountId: integrationResources.integrationAccountId,
        accountMetadata: integrationAccounts.metadata,
        kind: integrationResources.kind,
        provider: integrationAccounts.provider,
      })
      .from(integrationResources)
      .innerJoin(
        integrationAccounts,
        eq(integrationAccounts.id, integrationResources.integrationAccountId),
      )
      .where(
        and(
          eq(integrationAccounts.organizationId, organizationId),
          eq(integrationAccounts.status, "connected"),
          eq(integrationResources.available, true),
          inArray(integrationResources.id, [...contextResourceIds]),
        ),
      );
    if (
      contextResourceRows.length !== contextResourceIds.size ||
      contextResourceRows.some(
        (resource) =>
          !(
            (resource.provider === "slack" &&
              resource.kind === "slack_channel") ||
            (resource.provider === "vercel" &&
              resource.kind === "vercel_project" &&
              contextAccountIds.has(resource.integrationAccountId))
          ),
      )
    ) {
      throw new AgentConfigurationError(
        "Choose available context resources from connected accounts",
        "resource_not_found",
      );
    }
    const slackContextRows = contextResourceRows.filter(
      (resource) => resource.provider === "slack",
    );
    if (
      new Set(
        slackContextRows.map((resource) => resource.integrationAccountId),
      ).size !== 1
      && slackContextRows.length > 0
    ) {
      throw new AgentConfigurationError(
        "Choose Slack context channels from one Slack workspace",
        "resource_not_found",
      );
    }
    const userScopes = new Set(
      Array.isArray(slackContextRows[0]?.accountMetadata.userScopes)
        ? slackContextRows[0].accountMetadata.userScopes.filter(
            (scope): scope is string => typeof scope === "string",
          )
        : [],
    );
    const missingScope =
      slackContextRows.length > 0 && !userScopes.has("search:read");
    if (missingScope) {
      throw new AgentConfigurationError(
        "Reconnect Slack to use selected channels as agent context",
        "integration_not_found",
      );
    }
  }

  if (configuration.createLinearTickets) {
    const selectedLinearAccounts = [...contextAccountIds].filter(
      (accountId) => accountsById.get(accountId)?.provider === "linear",
    );
    if (selectedLinearAccounts.length !== 1) {
      throw new AgentConfigurationError(
        "Choose one connected Linear account for ticket creation",
        "integration_not_found",
      );
    }
  }

  const requiredResources = triggerResources(configuration.trigger);
  if (requiredResources) {
    const triggerExternalIds = new Set(requiredResources.externalIds);
    if (triggerExternalIds.size !== requiredResources.externalIds.length) {
      throw new AgentConfigurationError(
        "Trigger resources must be unique",
        "resource_not_found",
      );
    }
    if (triggerExternalIds.size > 0) {
      const resourceRows = await db
        .select({ externalId: integrationResources.externalId })
        .from(integrationResources)
        .where(
          and(
            eq(
              integrationResources.integrationAccountId,
              configuration.trigger.integrationAccountId,
            ),
            eq(integrationResources.kind, requiredResources.kind),
            eq(integrationResources.available, true),
            inArray(integrationResources.externalId, [...triggerExternalIds]),
          ),
        );
      if (resourceRows.length !== triggerExternalIds.size) {
        throw new AgentConfigurationError(
          "One or more trigger resources are unavailable",
          "resource_not_found",
        );
      }
    }
  }

  if (configuration.reporting.mode !== "thread") {
    const outputChannel = await db
      .select({ id: integrationResources.id })
      .from(integrationResources)
      .where(
        and(
          eq(
            integrationResources.integrationAccountId,
            configuration.reporting.integrationAccountId,
          ),
          eq(integrationResources.kind, "slack_channel"),
          eq(
            integrationResources.externalId,
            configuration.reporting.outputChannelId,
          ),
          eq(integrationResources.available, true),
        ),
      )
      .limit(1);
    if (!outputChannel[0]) {
      throw new AgentConfigurationError(
        "Choose an available Slack output channel",
        "resource_not_found",
      );
    }
  }

  const repositoryIds = new Set(configuration.repositoryIds);
  if (repositoryIds.size !== configuration.repositoryIds.length) {
    throw new AgentConfigurationError(
      "Repositories must be unique",
      "repository_not_found",
    );
  }
  if (repositoryIds.size > 0) {
    const repositoryRows = await db
      .select({ id: repositories.id })
      .from(repositories)
      .innerJoin(
        integrationAccounts,
        eq(integrationAccounts.id, repositories.integrationAccountId),
      )
      .where(
        and(
          eq(integrationAccounts.organizationId, organizationId),
          eq(integrationAccounts.provider, "github"),
          eq(integrationAccounts.status, "connected"),
          eq(repositories.available, true),
          inArray(repositories.id, [...repositoryIds]),
        ),
      );
    if (repositoryRows.length !== repositoryIds.size) {
      throw new AgentConfigurationError(
        "One or more repositories are unavailable",
        "repository_not_found",
      );
    }
  }

  const secretIds = new Set(configuration.secretIds);
  if (secretIds.size !== configuration.secretIds.length) {
    throw new AgentConfigurationError(
      "Workspace secrets must be unique",
      "resource_not_found",
    );
  }
  if (secretIds.size > 0) {
    const secretRows = await db
      .select({ id: workspaceSecrets.id })
      .from(workspaceSecrets)
      .where(
        and(
          eq(workspaceSecrets.organizationId, organizationId),
          inArray(workspaceSecrets.id, [...secretIds]),
        ),
      );
    if (secretRows.length !== secretIds.size) {
      throw new AgentConfigurationError(
        "Choose workspace secrets from this workspace",
        "resource_not_found",
      );
    }
  }
}

function splitTrigger(configuration: AgentConfiguration): {
  trigger: AgentConfiguration["trigger"]["kind"];
  triggerConfig: AgentTriggerConfig;
} {
  const { kind, ...triggerConfig } = configuration.trigger;
  return { trigger: kind, triggerConfig };
}

export async function createAgent(input: {
  organizationId: string;
  userId: string;
  configuration: AgentConfiguration;
  purpose?: "standard" | "slack_thread";
}): Promise<string> {
  await validateConfigurationResources(input.organizationId, input.configuration);
  const db = getDatabase();

  return db.transaction(async (tx) => {
    const insertedAgents = await tx
      .insert(agents)
      .values({
        organizationId: input.organizationId,
        name: input.configuration.name,
        description: input.configuration.description,
        enabled: input.configuration.enabled,
        purpose: input.purpose ?? "standard",
      })
      .returning({ id: agents.id });
    const agent = insertedAgents[0];
    if (!agent) throw new Error("Unable to create agent");

    const { trigger, triggerConfig } = splitTrigger(input.configuration);
    const insertedVersions = await tx
      .insert(agentConfigVersions)
      .values({
        agentId: agent.id,
        version: 1,
        prompt: input.configuration.instructions,
        model: input.configuration.model,
        trigger,
        triggerConfig,
        reportConfig: input.configuration.reporting as AgentReportConfig,
        contextAccountIds: input.configuration.contextAccountIds,
        contextResourceIds: input.configuration.contextResourceIds,
        legacyPrMode: input.configuration.prMode === "always",
        prMode: input.configuration.prMode,
        createLinearTickets: input.configuration.createLinearTickets,
        linearIssueTemplate: input.configuration.linearIssueTemplate,
        createdBy: input.userId,
      })
      .returning({ id: agentConfigVersions.id });
    const version = insertedVersions[0];
    if (!version) throw new Error("Unable to create agent configuration");

    if (input.configuration.repositoryIds.length > 0) {
      await tx.insert(agentVersionRepositories).values(
        input.configuration.repositoryIds.map((repositoryId) => ({
          agentConfigVersionId: version.id,
          repositoryId,
        })),
      );
    }

    if (input.configuration.secretIds.length > 0) {
      await tx.insert(agentVersionSecrets).values(
        input.configuration.secretIds.map((workspaceSecretId) => ({
          agentConfigVersionId: version.id,
          workspaceSecretId,
        })),
      );
    }

    await tx
      .update(agents)
      .set({ activeVersionId: version.id, updatedAt: new Date() })
      .where(eq(agents.id, agent.id));

    return agent.id;
  });
}

export async function updateAgent(input: {
  agentId: string;
  organizationId: string;
  userId: string;
  configuration: AgentConfiguration;
  purpose?: "standard" | "slack_thread";
}): Promise<void> {
  await validateConfigurationResources(input.organizationId, input.configuration);
  const db = getDatabase();

  await db.transaction(async (tx) => {
    const existingAgents = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.id, input.agentId),
          eq(agents.organizationId, input.organizationId),
          eq(agents.purpose, input.purpose ?? "standard"),
        ),
      )
      .limit(1)
      .for("update");
    if (!existingAgents[0]) {
      throw new AgentConfigurationError("Agent not found", "agent_not_found");
    }

    const versions = await tx
      .select({ version: agentConfigVersions.version })
      .from(agentConfigVersions)
      .where(eq(agentConfigVersions.agentId, input.agentId))
      .orderBy(desc(agentConfigVersions.version))
      .limit(1);
    const nextVersion = (versions[0]?.version ?? 0) + 1;
    const { trigger, triggerConfig } = splitTrigger(input.configuration);
    const insertedVersions = await tx
      .insert(agentConfigVersions)
      .values({
        agentId: input.agentId,
        version: nextVersion,
        prompt: input.configuration.instructions,
        model: input.configuration.model,
        trigger,
        triggerConfig,
        reportConfig: input.configuration.reporting as AgentReportConfig,
        contextAccountIds: input.configuration.contextAccountIds,
        contextResourceIds: input.configuration.contextResourceIds,
        legacyPrMode: input.configuration.prMode === "always",
        prMode: input.configuration.prMode,
        createLinearTickets: input.configuration.createLinearTickets,
        linearIssueTemplate: input.configuration.linearIssueTemplate,
        createdBy: input.userId,
      })
      .returning({ id: agentConfigVersions.id });
    const version = insertedVersions[0];
    if (!version) throw new Error("Unable to create agent configuration");

    if (input.configuration.repositoryIds.length > 0) {
      await tx.insert(agentVersionRepositories).values(
        input.configuration.repositoryIds.map((repositoryId) => ({
          agentConfigVersionId: version.id,
          repositoryId,
        })),
      );
    }

    if (input.configuration.secretIds.length > 0) {
      await tx.insert(agentVersionSecrets).values(
        input.configuration.secretIds.map((workspaceSecretId) => ({
          agentConfigVersionId: version.id,
          workspaceSecretId,
        })),
      );
    }

    await tx
      .update(agents)
      .set({
        name: input.configuration.name,
        description: input.configuration.description,
        enabled: input.configuration.enabled,
        activeVersionId: version.id,
        updatedAt: new Date(),
      })
      .where(eq(agents.id, input.agentId));
  });
}

export async function setAgentEnabled(input: {
  agentId: string;
  organizationId: string;
  enabled: boolean;
}): Promise<boolean> {
  const updatedAgents = await getDatabase()
    .update(agents)
    .set({ enabled: input.enabled, updatedAt: new Date() })
    .where(
      and(
        eq(agents.id, input.agentId),
        eq(agents.organizationId, input.organizationId),
      ),
    )
    .returning({ id: agents.id });

  return updatedAgents.length > 0;
}

export async function disableAgentsWithUnavailableRepositories(
  organizationId: string,
): Promise<Array<{ id: string; name: string }>> {
  const db = getDatabase();
  const unavailableRepository = db
    .select({ id: repositories.id })
    .from(agentVersionRepositories)
    .innerJoin(
      repositories,
      eq(repositories.id, agentVersionRepositories.repositoryId),
    )
    .innerJoin(
      integrationAccounts,
      eq(integrationAccounts.id, repositories.integrationAccountId),
    )
    .where(
      and(
        eq(agentVersionRepositories.agentConfigVersionId, agents.activeVersionId),
        eq(integrationAccounts.organizationId, organizationId),
        eq(integrationAccounts.provider, "github"),
        eq(repositories.available, false),
      ),
    )
    .limit(1);

  return db
    .update(agents)
    .set({ enabled: false, updatedAt: new Date() })
    .where(
      and(
        eq(agents.organizationId, organizationId),
        eq(agents.enabled, true),
        exists(unavailableRepository),
      ),
    )
    .returning({ id: agents.id, name: agents.name });
}

export async function listAgentOptions(organizationId: string) {
  const db = getDatabase();
  const [accountRows, workspaceSecretRows] = await Promise.all([
    db
      .select({
        id: integrationAccounts.id,
        provider: integrationAccounts.provider,
        displayName: integrationAccounts.displayName,
        metadata: integrationAccounts.metadata,
      })
      .from(integrationAccounts)
      .where(
        and(
          eq(integrationAccounts.organizationId, organizationId),
          eq(integrationAccounts.status, "connected"),
        ),
      ),
    listWorkspaceSecrets(organizationId),
  ]);
  const secretRows = workspaceSecretRows.map((secret) => ({
    id: secret.id,
    name: secret.name,
    allowedHosts: secret.allowedHosts,
  }));
  const accounts = accountRows
    .filter(
      (account) =>
        account.provider !== "linear" ||
        account.metadata.authVersion === LINEAR_AUTH_VERSION,
    )
    .map(({ metadata, ...account }) => ({
      ...account,
      slackContextAvailable:
        account.provider === "slack" &&
        Array.isArray(metadata.userScopes) &&
        metadata.userScopes.includes("search:read"),
    }));
  const accountIds = accounts.map((account) => account.id);

  if (accountIds.length === 0) {
    return { accounts: [], resources: [], repositories: [], secrets: secretRows };
  }

  const [resources, repositoryRows] = await Promise.all([
    db
      .select({
        id: integrationResources.id,
        integrationAccountId: integrationResources.integrationAccountId,
        kind: integrationResources.kind,
        externalId: integrationResources.externalId,
        displayName: integrationResources.displayName,
      })
      .from(integrationResources)
      .where(
        and(
          inArray(integrationResources.integrationAccountId, accountIds),
          eq(integrationResources.available, true),
        ),
      ),
    db
      .select({
        id: repositories.id,
        integrationAccountId: repositories.integrationAccountId,
        fullName: repositories.fullName,
        defaultBranch: repositories.defaultBranch,
        private: repositories.private,
      })
      .from(repositories)
      .where(
        and(
          inArray(repositories.integrationAccountId, accountIds),
          eq(repositories.available, true),
        ),
      ),
  ]);

  return { accounts, resources, repositories: repositoryRows, secrets: secretRows };
}

export async function listAgents(organizationId: string) {
  const db = getDatabase();
  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      description: agents.description,
      enabled: agents.enabled,
      updatedAt: agents.updatedAt,
      activeVersionId: agents.activeVersionId,
      trigger: agentConfigVersions.trigger,
      triggerConfig: agentConfigVersions.triggerConfig,
      reportConfig: agentConfigVersions.reportConfig,
      prMode: agentConfigVersions.prMode,
    })
    .from(agents)
    .leftJoin(
      agentConfigVersions,
      eq(agentConfigVersions.id, agents.activeVersionId),
    )
    .where(
      and(
        eq(agents.organizationId, organizationId),
        eq(agents.purpose, "standard"),
      ),
    )
    .orderBy(desc(agents.updatedAt));

  const agentIds = rows.map((agent) => agent.id);
  const versionIds = rows
    .map((agent) => agent.activeVersionId)
    .filter((versionId): versionId is string => Boolean(versionId));
  const [runRows, versionRepositoryRows] = await Promise.all([
    agentIds.length === 0
      ? Promise.resolve([])
      : db
          .select({
            agentId: investigations.agentId,
            status: investigations.status,
            createdAt: investigations.createdAt,
          })
          .from(investigations)
          .where(inArray(investigations.agentId, agentIds))
          .orderBy(desc(investigations.createdAt)),
    versionIds.length === 0
      ? Promise.resolve([])
      : db
          .select({
            versionId: agentVersionRepositories.agentConfigVersionId,
          })
          .from(agentVersionRepositories)
          .where(
            inArray(agentVersionRepositories.agentConfigVersionId, versionIds),
          ),
  ]);
  const latestRuns = new Map<string, (typeof runRows)[number]>();
  for (const run of runRows) {
    if (!latestRuns.has(run.agentId)) latestRuns.set(run.agentId, run);
  }
  const repositoryCounts = new Map<string, number>();
  for (const row of versionRepositoryRows) {
    repositoryCounts.set(
      row.versionId,
      (repositoryCounts.get(row.versionId) ?? 0) + 1,
    );
  }

  return rows.map((agent) => ({
    ...agent,
    repositoryCount: agent.activeVersionId
      ? repositoryCounts.get(agent.activeVersionId) ?? 0
      : 0,
    latestRun: latestRuns.get(agent.id) ?? null,
  }));
}

export async function getAgent(
  organizationId: string,
  agentId: string,
) {
  const db = getDatabase();
  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      description: agents.description,
      enabled: agents.enabled,
      createdAt: agents.createdAt,
      updatedAt: agents.updatedAt,
      versionId: agentConfigVersions.id,
      version: agentConfigVersions.version,
      model: agentConfigVersions.model,
      instructions: agentConfigVersions.prompt,
      trigger: agentConfigVersions.trigger,
      triggerConfig: agentConfigVersions.triggerConfig,
      reporting: agentConfigVersions.reportConfig,
      contextAccountIds: agentConfigVersions.contextAccountIds,
      contextResourceIds: agentConfigVersions.contextResourceIds,
      prMode: agentConfigVersions.prMode,
      createLinearTickets: agentConfigVersions.createLinearTickets,
      linearIssueTemplate: agentConfigVersions.linearIssueTemplate,
    })
    .from(agents)
    .leftJoin(
      agentConfigVersions,
      eq(agentConfigVersions.id, agents.activeVersionId),
    )
    .where(
      and(
        eq(agents.id, agentId),
        eq(agents.organizationId, organizationId),
        eq(agents.purpose, "standard"),
      ),
    )
    .limit(1);
  const agent = rows[0];
  if (!agent) return null;

  const [repositoryRows, secretRows, investigationRows] = await Promise.all([
    agent.versionId
      ? db
          .select({
            id: repositories.id,
            fullName: repositories.fullName,
            defaultBranch: repositories.defaultBranch,
            private: repositories.private,
          })
          .from(agentVersionRepositories)
          .innerJoin(
            repositories,
            eq(repositories.id, agentVersionRepositories.repositoryId),
          )
          .where(
            eq(
              agentVersionRepositories.agentConfigVersionId,
              agent.versionId,
            ),
          )
      : Promise.resolve([]),
    agent.versionId
      ? db
          .select({ id: workspaceSecrets.id })
          .from(agentVersionSecrets)
          .innerJoin(
            workspaceSecrets,
            eq(workspaceSecrets.id, agentVersionSecrets.workspaceSecretId),
          )
          .where(
            and(
              eq(agentVersionSecrets.agentConfigVersionId, agent.versionId),
              eq(workspaceSecrets.organizationId, organizationId),
            ),
          )
      : Promise.resolve([]),
    db
      .select({
        id: investigations.id,
        title: investigations.title,
        status: investigations.status,
        input: investigations.input,
        finding: investigations.finding,
        structuredReport: investigations.structuredReport,
        replayReport: investigations.replayReport,
        isReplay: investigations.isReplay,
        replayOfInvestigationId: investigations.replayOfInvestigationId,
        failureReason: investigations.failureReason,
        createdAt: investigations.createdAt,
        completedAt: investigations.completedAt,
      })
      .from(investigations)
      .where(eq(investigations.agentId, agent.id))
      .orderBy(desc(investigations.createdAt))
      .limit(50),
  ]);

  return {
    ...agent,
    configuration:
      agent.versionId && agent.trigger && agent.triggerConfig && agent.reporting
        ? {
            name: agent.name,
            description: agent.description,
            enabled: agent.enabled,
            model: agent.model,
            instructions: agent.instructions,
            prMode: agent.prMode,
            createLinearTickets: agent.createLinearTickets,
            linearIssueTemplate: agent.linearIssueTemplate,
            repositoryIds: repositoryRows.map((repository) => repository.id),
            contextAccountIds: agent.contextAccountIds ?? [],
            contextResourceIds: agent.contextResourceIds ?? [],
            secretIds: secretRows.map((secret) => secret.id),
            trigger: {
              kind: agent.trigger,
              ...agent.triggerConfig,
            },
            reporting: agent.reporting,
          }
        : null,
    repositories: repositoryRows,
    investigations: investigationRows.map(
      ({ structuredReport, replayReport, ...investigation }) => ({
        ...investigation,
        finding:
          (investigation.finding
            ? { summary: investigation.finding.summary }
            : null) ??
          (structuredReport ? { summary: structuredReport.summary } : null) ??
          (replayReport ? { summary: replayReport.summary } : null),
      }),
    ),
  };
}

export async function getSlackThreadModeConfiguration(
  organizationId: string,
): Promise<SlackThreadModeConfiguration | null> {
  const db = getDatabase();
  const rows = await db
    .select({
      enabled: agents.enabled,
      versionId: agentConfigVersions.id,
      model: agentConfigVersions.model,
      instructions: agentConfigVersions.prompt,
      contextAccountIds: agentConfigVersions.contextAccountIds,
      contextResourceIds: agentConfigVersions.contextResourceIds,
    })
    .from(agents)
    .innerJoin(
      agentConfigVersions,
      eq(agentConfigVersions.id, agents.activeVersionId),
    )
    .where(
      and(
        eq(agents.organizationId, organizationId),
        eq(agents.purpose, "slack_thread"),
      ),
    )
    .limit(1);
  const configuration = rows[0];
  if (!configuration) return null;

  const [repositoryRows, secretRows] = await Promise.all([
    db
      .select({ id: agentVersionRepositories.repositoryId })
      .from(agentVersionRepositories)
      .where(
        eq(
          agentVersionRepositories.agentConfigVersionId,
          configuration.versionId,
        ),
      ),
    db
      .select({ id: agentVersionSecrets.workspaceSecretId })
      .from(agentVersionSecrets)
      .where(
        eq(agentVersionSecrets.agentConfigVersionId, configuration.versionId),
      ),
  ]);

  return {
    enabled: configuration.enabled,
    model: configuration.model,
    instructions: configuration.instructions,
    repositoryIds: repositoryRows.map((row) => row.id),
    contextAccountIds: configuration.contextAccountIds,
    contextResourceIds: configuration.contextResourceIds,
    secretIds: secretRows.map((row) => row.id),
  };
}

export async function saveSlackThreadModeConfiguration(input: {
  organizationId: string;
  userId: string;
  configuration: SlackThreadModeConfiguration;
}): Promise<void> {
  const db = getDatabase();
  const slackAccounts = await db
    .select({ id: integrationAccounts.id })
    .from(integrationAccounts)
    .where(
      and(
        eq(integrationAccounts.organizationId, input.organizationId),
        eq(integrationAccounts.provider, "slack"),
        eq(integrationAccounts.status, "connected"),
      ),
    )
    .limit(1);
  const slackAccount = slackAccounts[0];
  if (!slackAccount) {
    throw new AgentConfigurationError(
      "Connect Slack before enabling tag mode",
      "integration_not_found",
    );
  }

  const configuration: AgentConfiguration = {
    name: "Responder tag mode",
    description: "Runs ad-hoc investigations from Slack mentions.",
    model: input.configuration.model,
    instructions: input.configuration.instructions,
    enabled: input.configuration.enabled,
    prMode: "disabled",
    repositoryIds: input.configuration.repositoryIds,
    contextAccountIds: input.configuration.contextAccountIds,
    contextResourceIds: input.configuration.contextResourceIds,
    secretIds: input.configuration.secretIds,
    createLinearTickets: false,
    linearIssueTemplate: "",
    trigger: {
      kind: "slack_mention",
      integrationAccountId: slackAccount.id,
      channelIds: [],
    },
    reporting: { mode: "thread" },
  };
  const existing = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.organizationId, input.organizationId),
        eq(agents.purpose, "slack_thread"),
      ),
    )
    .limit(1);

  if (existing[0]) {
    await updateAgent({
      agentId: existing[0].id,
      organizationId: input.organizationId,
      userId: input.userId,
      configuration,
      purpose: "slack_thread",
    });
    return;
  }
  await createAgent({
    organizationId: input.organizationId,
    userId: input.userId,
    configuration,
    purpose: "slack_thread",
  });
}
