import { randomUUID } from "node:crypto";
import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import type {
  AutomationConfiguration,
  AutomationInput,
  AutomationTrigger,
} from "../automations/config.js";
import { getDatabase } from "./client.js";
import {
  automationRunEvents,
  automationActionAttempts,
  automationRuns,
  automationTriggerReceipts,
  automationVersionIntegrationAccounts,
  automationVersionRepositories,
  automationVersionSecrets,
  automationVersions,
  automations,
  integrationAccounts,
  integrationResources,
  organizationCapabilities,
  organizationModelCredentials,
  repositories,
  workspaceSecrets,
  type AutomationRunStatus,
} from "./schema.js";

type AutomationTransaction = Parameters<
  Parameters<ReturnType<typeof getDatabase>["transaction"]>[0]
>[0];

export class AutomationConfigurationError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "automation_not_found"
      | "capability_disabled"
      | "credential_not_found"
      | "integration_not_found"
      | "repository_not_found"
      | "secret_not_found",
  ) {
    super(message);
    this.name = "AutomationConfigurationError";
  }
}

export async function findAutomationsForSlackEvent(input: {
  channelId: string;
  eventType: "app_mention" | "message";
  senderAppId?: string;
  teamId: string;
  userId?: string;
}): Promise<Array<{ automationId: string }>> {
  const rows = await getDatabase()
    .select({
      accountId: integrationAccounts.id,
      accountMetadata: integrationAccounts.metadata,
      automationId: automations.id,
      trigger: automationVersions.trigger,
    })
    .from(automations)
    .innerJoin(
      organizationCapabilities,
      and(
        eq(organizationCapabilities.organizationId, automations.organizationId),
        eq(organizationCapabilities.capability, "automations"),
        eq(organizationCapabilities.enabled, true),
      ),
    )
    .innerJoin(
      automationVersions,
      eq(automationVersions.id, automations.activeVersionId),
    )
    .innerJoin(
      integrationAccounts,
      and(
        eq(integrationAccounts.organizationId, automations.organizationId),
        eq(integrationAccounts.provider, "slack"),
        eq(integrationAccounts.externalAccountId, input.teamId),
        eq(integrationAccounts.status, "connected"),
      ),
    )
    .innerJoin(
      integrationResources,
      and(
        eq(integrationResources.integrationAccountId, integrationAccounts.id),
        eq(integrationResources.kind, "slack_channel"),
        eq(integrationResources.externalId, input.channelId),
        eq(integrationResources.available, true),
      ),
    )
    .where(eq(automations.enabled, true));

  return rows.flatMap((row) => {
    if (
      row.trigger.kind !== "slack" ||
      row.trigger.integrationAccountId !== row.accountId ||
      !row.trigger.channelIds.includes(input.channelId) ||
      (input.userId && row.accountMetadata.botUserId === input.userId) ||
      (input.senderAppId && row.accountMetadata.appId === input.senderAppId)
    ) {
      return [];
    }
    const matches = row.trigger.eventMode === "both" ||
      (row.trigger.eventMode === "mentions" && input.eventType === "app_mention") ||
      (row.trigger.eventMode === "every_message" && input.eventType === "message");
    return matches ? [{ automationId: row.automationId }] : [];
  });
}

export async function findAutomationsForSentryIssue(input: {
  action: "created" | "unresolved";
  installationId: string;
  projectId: string;
}): Promise<Array<{ automationId: string }>> {
  const rows = await getDatabase()
    .select({
      accountId: integrationAccounts.id,
      automationId: automations.id,
      trigger: automationVersions.trigger,
    })
    .from(automations)
    .innerJoin(
      organizationCapabilities,
      and(
        eq(organizationCapabilities.organizationId, automations.organizationId),
        eq(organizationCapabilities.capability, "automations"),
        eq(organizationCapabilities.enabled, true),
      ),
    )
    .innerJoin(
      automationVersions,
      eq(automationVersions.id, automations.activeVersionId),
    )
    .innerJoin(
      integrationAccounts,
      and(
        eq(integrationAccounts.organizationId, automations.organizationId),
        eq(integrationAccounts.provider, "sentry"),
        eq(integrationAccounts.externalAccountId, input.installationId),
        eq(integrationAccounts.status, "connected"),
      ),
    )
    .innerJoin(
      integrationResources,
      and(
        eq(integrationResources.integrationAccountId, integrationAccounts.id),
        eq(integrationResources.kind, "sentry_project"),
        eq(integrationResources.externalId, input.projectId),
        eq(integrationResources.available, true),
      ),
    )
    .where(eq(automations.enabled, true));
  const eventType = input.action === "created" ? "new_issue" : "regression";
  return rows.flatMap((row) =>
    row.trigger.kind === "sentry" &&
      row.trigger.integrationAccountId === row.accountId &&
      row.trigger.projectIds.includes(input.projectId) &&
      row.trigger.eventTypes.includes(eventType)
      ? [{ automationId: row.automationId }]
      : []
  );
}

export async function findAutomationsForDiscordCommand(input: {
  channelId: string;
  guildId: string;
}): Promise<Array<{ automationId: string }>> {
  const rows = await getDatabase()
    .select({
      accountId: integrationAccounts.id,
      automationId: automations.id,
      trigger: automationVersions.trigger,
    })
    .from(automations)
    .innerJoin(
      organizationCapabilities,
      and(
        eq(organizationCapabilities.organizationId, automations.organizationId),
        eq(organizationCapabilities.capability, "automations"),
        eq(organizationCapabilities.enabled, true),
      ),
    )
    .innerJoin(
      automationVersions,
      eq(automationVersions.id, automations.activeVersionId),
    )
    .innerJoin(
      integrationAccounts,
      and(
        eq(integrationAccounts.organizationId, automations.organizationId),
        eq(integrationAccounts.provider, "discord"),
        eq(integrationAccounts.externalAccountId, input.guildId),
        eq(integrationAccounts.status, "connected"),
      ),
    )
    .innerJoin(
      integrationResources,
      and(
        eq(integrationResources.integrationAccountId, integrationAccounts.id),
        eq(integrationResources.kind, "discord_channel"),
        eq(integrationResources.externalId, input.channelId),
        eq(integrationResources.available, true),
      ),
    )
    .where(eq(automations.enabled, true));

  return rows.flatMap((row) =>
    row.trigger.kind === "discord" &&
      row.trigger.integrationAccountId === row.accountId &&
      row.trigger.channelIds.includes(input.channelId)
      ? [{ automationId: row.automationId }]
      : []
  );
}

function triggerProvider(trigger: AutomationTrigger): "discord" | "sentry" | "slack" {
  return trigger.kind;
}

async function validateConfigurationResources(
  tx: AutomationTransaction,
  organizationId: string,
  configuration: AutomationConfiguration,
): Promise<void> {
  const accountIds = [
    ...new Set([
      configuration.trigger.integrationAccountId,
      ...configuration.contextAccountIds,
    ]),
  ];
  const accountRows = await tx
    .select({ id: integrationAccounts.id, provider: integrationAccounts.provider })
    .from(integrationAccounts)
    .where(
      and(
        eq(integrationAccounts.organizationId, organizationId),
        eq(integrationAccounts.status, "connected"),
        inArray(integrationAccounts.id, accountIds),
      ),
    );
  if (accountRows.length !== accountIds.length) {
    throw new AutomationConfigurationError(
      "One or more selected integrations are unavailable",
      "integration_not_found",
    );
  }
  const triggerAccount = accountRows.find(
    (account) => account.id === configuration.trigger.integrationAccountId,
  );
  if (triggerAccount?.provider !== triggerProvider(configuration.trigger)) {
    throw new AutomationConfigurationError(
      "The selected trigger integration has the wrong provider",
      "integration_not_found",
    );
  }
  const triggerResource = configuration.trigger.kind === "sentry"
    ? {
        externalIds: configuration.trigger.projectIds,
        kind: "sentry_project" as const,
      }
    : {
        externalIds: configuration.trigger.channelIds,
        kind: configuration.trigger.kind === "slack"
          ? "slack_channel" as const
          : "discord_channel" as const,
      };
  const triggerResources = await tx
    .select({ externalId: integrationResources.externalId })
    .from(integrationResources)
    .where(
      and(
        eq(
          integrationResources.integrationAccountId,
          configuration.trigger.integrationAccountId,
        ),
        eq(integrationResources.kind, triggerResource.kind),
        eq(integrationResources.available, true),
        inArray(integrationResources.externalId, triggerResource.externalIds),
      ),
    );
  if (triggerResources.length !== triggerResource.externalIds.length) {
    throw new AutomationConfigurationError(
      "One or more selected trigger resources are unavailable",
      "integration_not_found",
    );
  }
  const supportedContextProviders = new Set([
    "custom_mcp",
    "datadog",
    "sentry",
    "slack",
  ]);
  if (
    configuration.contextAccountIds.some((accountId) => {
      const account = accountRows.find((row) => row.id === accountId);
      return !account || !supportedContextProviders.has(account.provider);
    })
  ) {
    throw new AutomationConfigurationError(
      "One or more selected integrations do not expose automation context tools",
      "integration_not_found",
    );
  }

  const credentialRows = await tx
    .select({ id: organizationModelCredentials.id, authType: organizationModelCredentials.authType })
    .from(organizationModelCredentials)
    .where(
      and(
        eq(organizationModelCredentials.id, configuration.modelCredentialId),
        eq(organizationModelCredentials.organizationId, organizationId),
        eq(organizationModelCredentials.provider, configuration.modelProvider),
        eq(organizationModelCredentials.status, "active"),
      ),
    )
    .limit(1);
  if (!credentialRows[0]) {
    throw new AutomationConfigurationError(
      "The selected model credential is unavailable",
      "credential_not_found",
    );
  }

  if (credentialRows[0].authType === "chatgpt_subscription" && (configuration.harness !== "codex" || configuration.modelProvider !== "openai")) {
    throw new AutomationConfigurationError("ChatGPT subscriptions require the Codex harness", "credential_not_found");
  }

  const repositoryRows = await tx
    .select({ id: repositories.id })
    .from(repositories)
    .innerJoin(
      integrationAccounts,
      and(
        eq(integrationAccounts.id, repositories.integrationAccountId),
        eq(integrationAccounts.organizationId, organizationId),
        eq(integrationAccounts.provider, "github"),
        eq(integrationAccounts.status, "connected"),
      ),
    )
    .where(
      and(
        inArray(repositories.id, configuration.repositoryIds),
        eq(repositories.available, true),
      ),
    );
  if (repositoryRows.length !== configuration.repositoryIds.length) {
    throw new AutomationConfigurationError(
      "One or more selected repositories are unavailable",
      "repository_not_found",
    );
  }

  if (configuration.workspaceSecretIds.length > 0) {
    const secretRows = await tx
      .select({ id: workspaceSecrets.id })
      .from(workspaceSecrets)
      .where(
        and(
          eq(workspaceSecrets.organizationId, organizationId),
          inArray(workspaceSecrets.id, configuration.workspaceSecretIds),
        ),
      );
    if (secretRows.length !== configuration.workspaceSecretIds.length) {
      throw new AutomationConfigurationError(
        "One or more selected workspace secrets are unavailable",
        "secret_not_found",
      );
    }
  }
}

async function insertAutomationVersion(
  tx: AutomationTransaction,
  input: {
    automationId: string;
    configuration: AutomationConfiguration;
    createdBy: string;
    version: number;
  },
): Promise<string> {
  const rows = await tx
    .insert(automationVersions)
    .values({
      automationId: input.automationId,
      connectionMode: "all_selected",
      createdBy: input.createdBy,
      harness: input.configuration.harness,
      maxModelRequests: input.configuration.maxModelRequests,
      maxOutputTokensPerRequest:
        input.configuration.maxOutputTokensPerRequest,
      maxRuntimeSeconds: input.configuration.maxRuntimeSeconds,
      model: input.configuration.model,
      modelCredentialId: input.configuration.modelCredentialId,
      modelProvider: input.configuration.modelProvider,
      prompt: input.configuration.prompt,
      toolPolicy: input.configuration.toolPolicy,
      trigger: input.configuration.trigger,
      version: input.version,
    })
    .returning({ id: automationVersions.id });
  const versionId = rows[0]?.id;
  if (!versionId) throw new Error("Unable to create automation version");

  const accountLinks = [
    {
      integrationAccountId: input.configuration.trigger.integrationAccountId,
      role: "trigger" as const,
    },
    ...input.configuration.contextAccountIds.map((integrationAccountId) => ({
      integrationAccountId,
      role: "context" as const,
    })),
  ];
  await Promise.all([
    tx.insert(automationVersionIntegrationAccounts).values(
      accountLinks.map(({ integrationAccountId, role }) => ({
        automationVersionId: versionId,
        integrationAccountId,
        role,
      })),
    ),
    tx.insert(automationVersionRepositories).values(
      input.configuration.repositoryIds.map((repositoryId) => ({
        automationVersionId: versionId,
        repositoryId,
      })),
    ),
    ...(input.configuration.workspaceSecretIds.length > 0
      ? [
          tx.insert(automationVersionSecrets).values(
            input.configuration.workspaceSecretIds.map((workspaceSecretId) => ({
              automationVersionId: versionId,
              workspaceSecretId,
            })),
          ),
        ]
      : []),
  ]);
  return versionId;
}

export async function createAutomation(
  organizationId: string,
  createdBy: string,
  input: AutomationInput,
): Promise<{ id: string }> {
  return getDatabase().transaction(async (tx) => {
    await validateConfigurationResources(tx, organizationId, input.configuration);
    const rows = await tx
      .insert(automations)
      .values({
        createdBy,
        description: input.description,
        enabled: input.enabled,
        name: input.name,
        organizationId,
      })
      .returning({ id: automations.id });
    const automationId = rows[0]?.id;
    if (!automationId) throw new Error("Unable to create automation");
    const versionId = await insertAutomationVersion(tx, {
      automationId,
      configuration: input.configuration,
      createdBy,
      version: 1,
    });
    await tx
      .update(automations)
      .set({ activeVersionId: versionId, updatedAt: new Date() })
      .where(eq(automations.id, automationId));
    return { id: automationId };
  });
}

export async function updateAutomation(
  organizationId: string,
  automationId: string,
  createdBy: string,
  input: AutomationInput,
): Promise<boolean> {
  return getDatabase().transaction(async (tx) => {
    await tx.execute(
      sql`select ${automations.id} from ${automations} where ${automations.id} = ${automationId} and ${automations.organizationId} = ${organizationId} for update`,
    );
    const existing = await tx
      .select({ id: automations.id })
      .from(automations)
      .where(
        and(
          eq(automations.id, automationId),
          eq(automations.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!existing[0]) return false;
    await validateConfigurationResources(tx, organizationId, input.configuration);
    const previousVersions = await tx
      .select({ version: automationVersions.version })
      .from(automationVersions)
      .where(eq(automationVersions.automationId, automationId))
      .orderBy(desc(automationVersions.version))
      .limit(1);
    const versionId = await insertAutomationVersion(tx, {
      automationId,
      configuration: input.configuration,
      createdBy,
      version: (previousVersions[0]?.version ?? 0) + 1,
    });
    await tx
      .update(automations)
      .set({
        activeVersionId: versionId,
        description: input.description,
        enabled: input.enabled,
        name: input.name,
        updatedAt: new Date(),
      })
      .where(eq(automations.id, automationId));
    return true;
  });
}

export async function setAutomationEnabled(input: {
  automationId: string;
  enabled: boolean;
  organizationId: string;
}): Promise<boolean> {
  const rows = await getDatabase()
    .update(automations)
    .set({ enabled: input.enabled, updatedAt: new Date() })
    .where(
      and(
        eq(automations.id, input.automationId),
        eq(automations.organizationId, input.organizationId),
      ),
    )
    .returning({ id: automations.id });
  return rows.length > 0;
}

export async function listAutomations(organizationId: string) {
  return getDatabase()
    .select({
      createdAt: automations.createdAt,
      description: automations.description,
      enabled: automations.enabled,
      harness: automationVersions.harness,
      id: automations.id,
      model: automationVersions.model,
      modelProvider: automationVersions.modelProvider,
      name: automations.name,
      trigger: automationVersions.trigger,
      updatedAt: automations.updatedAt,
      version: automationVersions.version,
    })
    .from(automations)
    .innerJoin(
      automationVersions,
      eq(automationVersions.id, automations.activeVersionId),
    )
    .where(eq(automations.organizationId, organizationId))
    .orderBy(desc(automations.updatedAt));
}

export async function getAutomation(
  organizationId: string,
  automationId: string,
) {
  const db = getDatabase();
  const rows = await db
    .select({
      configuration: {
        harness: automationVersions.harness,
        maxModelRequests: automationVersions.maxModelRequests,
        maxOutputTokensPerRequest:
          automationVersions.maxOutputTokensPerRequest,
        maxRuntimeSeconds: automationVersions.maxRuntimeSeconds,
        model: automationVersions.model,
        modelCredentialId: automationVersions.modelCredentialId,
        modelProvider: automationVersions.modelProvider,
        prompt: automationVersions.prompt,
        toolPolicy: automationVersions.toolPolicy,
        trigger: automationVersions.trigger,
      },
      createdAt: automations.createdAt,
      description: automations.description,
      enabled: automations.enabled,
      id: automations.id,
      name: automations.name,
      updatedAt: automations.updatedAt,
      versionId: automationVersions.id,
      version: automationVersions.version,
    })
    .from(automations)
    .innerJoin(
      automationVersions,
      eq(automationVersions.id, automations.activeVersionId),
    )
    .where(
      and(
        eq(automations.id, automationId),
        eq(automations.organizationId, organizationId),
      ),
    )
    .limit(1);
  const automation = rows[0];
  if (!automation) return null;
  const [accountRows, repositoryRows, secretRows, runRows] = await Promise.all([
    db
      .select({
        id: automationVersionIntegrationAccounts.integrationAccountId,
        role: automationVersionIntegrationAccounts.role,
      })
      .from(automationVersionIntegrationAccounts)
      .where(
        eq(
          automationVersionIntegrationAccounts.automationVersionId,
          automation.versionId,
        ),
      ),
    db
      .select({ id: automationVersionRepositories.repositoryId })
      .from(automationVersionRepositories)
      .where(
        eq(
          automationVersionRepositories.automationVersionId,
          automation.versionId,
        ),
      ),
    db
      .select({ id: automationVersionSecrets.workspaceSecretId })
      .from(automationVersionSecrets)
      .where(
        eq(automationVersionSecrets.automationVersionId, automation.versionId),
      ),
    db
      .select({
        completedAt: automationRuns.completedAt,
        createdAt: automationRuns.createdAt,
        failureCategory: automationRuns.failureCategory,
        failureMessage: automationRuns.failureMessage,
        id: automationRuns.id,
        resultSummary: automationRuns.resultSummary,
        startedAt: automationRuns.startedAt,
        status: automationRuns.status,
        usage: automationRuns.usage,
      })
      .from(automationRuns)
      .where(
        and(
          eq(automationRuns.automationId, automationId),
          eq(automationRuns.organizationId, organizationId),
        ),
      )
      .orderBy(desc(automationRuns.createdAt))
      .limit(50),
  ]);
  return {
    ...automation,
    configuration: {
      ...automation.configuration,
      contextAccountIds: accountRows
        .filter((row) => row.role === "context")
        .map((row) => row.id),
      repositoryIds: repositoryRows.map((row) => row.id),
      workspaceSecretIds: secretRows.map((row) => row.id),
    },
    runs: runRows,
  };
}

export async function getAutomationRun(
  organizationId: string,
  runId: string,
) {
  const db = getDatabase();
  const rows = await db
    .select({
      automationId: automationRuns.automationId,
      automationVersionId: automationRuns.automationVersionId,
      cancelRequestedAt: automationRuns.cancelRequestedAt,
      completedAt: automationRuns.completedAt,
      createdAt: automationRuns.createdAt,
      failureCategory: automationRuns.failureCategory,
      failureMessage: automationRuns.failureMessage,
      heartbeatAt: automationRuns.heartbeatAt,
      id: automationRuns.id,
      organizationId: automationRuns.organizationId,
      redactedTrigger: automationRuns.redactedTrigger,
      resultSummary: automationRuns.resultSummary,
      sandboxId: automationRuns.sandboxId,
      startedAt: automationRuns.startedAt,
      status: automationRuns.status,
      updatedAt: automationRuns.updatedAt,
      usage: automationRuns.usage,
    })
    .from(automationRuns)
    .where(
      and(
        eq(automationRuns.id, runId),
        eq(automationRuns.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!rows[0]) return null;
  const events = await db
    .select()
    .from(automationRunEvents)
    .where(eq(automationRunEvents.runId, runId))
    .orderBy(automationRunEvents.id);
  return { ...rows[0], events };
}

export async function requestAutomationRunCancellation(input: {
  organizationId: string;
  runId: string;
}): Promise<boolean> {
  const rows = await getDatabase()
    .update(automationRuns)
    .set({ cancelRequestedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(automationRuns.id, input.runId),
        eq(automationRuns.organizationId, input.organizationId),
        inArray(automationRuns.status, ["pending", "running"]),
      ),
    )
    .returning({ id: automationRuns.id });
  return rows.length > 0;
}

export interface AutomationTriggerInput {
  attributes?: Record<string, string | number | boolean | null>;
  body: string;
  externalEventId: string;
  provider: "discord" | "manual" | "sentry" | "slack";
  sourceUrl?: string;
  title: string;
}

export async function beginAutomationRun(input: {
  automationId: string;
  trigger: AutomationTriggerInput;
}): Promise<{ created: boolean; runId: string }> {
  return getDatabase().transaction(async (tx) => {
    const rows = await tx
      .select({
        automationVersionId: automations.activeVersionId,
        enabled: automations.enabled,
        organizationId: automations.organizationId,
      })
      .from(automations)
      .innerJoin(
        organizationCapabilities,
        and(
          eq(
            organizationCapabilities.organizationId,
            automations.organizationId,
          ),
          eq(organizationCapabilities.capability, "automations"),
          eq(organizationCapabilities.enabled, true),
        ),
      )
      .where(eq(automations.id, input.automationId))
      .limit(1);
    const automation = rows[0];
    if (!automation?.enabled || !automation.automationVersionId) {
      throw new AutomationConfigurationError(
        "Automation is unavailable",
        automation ? "capability_disabled" : "automation_not_found",
      );
    }

    const runId = randomUUID();
    await tx.insert(automationRuns).values({
      automationId: input.automationId,
      automationVersionId: automation.automationVersionId,
      id: runId,
      organizationId: automation.organizationId,
      redactedTrigger: {
        attributes: input.trigger.attributes ?? {},
        provider: input.trigger.provider,
        sourceUrl: input.trigger.sourceUrl,
        title: input.trigger.title,
      },
      status: "pending",
      triggerInput: input.trigger as unknown as Record<string, unknown>,
    });
    const receipts = await tx
      .insert(automationTriggerReceipts)
      .values({
        automationId: input.automationId,
        externalEventId: input.trigger.externalEventId,
        provider: input.trigger.provider,
        runId,
      })
      .onConflictDoNothing()
      .returning({ id: automationTriggerReceipts.id });
    if (receipts.length > 0) return { created: true, runId };

    await tx.delete(automationRuns).where(eq(automationRuns.id, runId));
    const existing = await tx
      .select({ runId: automationTriggerReceipts.runId })
      .from(automationTriggerReceipts)
      .where(
        and(
          eq(automationTriggerReceipts.automationId, input.automationId),
          eq(automationTriggerReceipts.provider, input.trigger.provider),
          eq(
            automationTriggerReceipts.externalEventId,
            input.trigger.externalEventId,
          ),
        ),
      )
      .limit(1);
    if (!existing[0]) throw new Error("Unable to resolve automation trigger");
    return { created: false, runId: existing[0].runId };
  });
}

export async function abandonPendingAutomationRun(runId: string): Promise<boolean> {
  const rows = await getDatabase()
    .delete(automationRuns)
    .where(
      and(
        eq(automationRuns.id, runId),
        eq(automationRuns.status, "pending"),
      ),
    )
    .returning({ id: automationRuns.id });
  return rows.length > 0;
}

export async function appendAutomationRunEvent(input: {
  data?: Record<string, unknown>;
  runId: string;
  type: string;
}): Promise<void> {
  await getDatabase().insert(automationRunEvents).values(input);
}

export async function beginAutomationActionAttempt(input: {
  idempotencyKey: string;
  kind: "open_github_pull_request" | "send_slack_message";
  redactedInput: Record<string, unknown>;
  runId: string;
  toolCallId: string;
}): Promise<
  | { id: string; status: "started" }
  | { externalReference: string | null; id: string; status: "existing_succeeded" }
> {
  const rows = await getDatabase()
    .insert(automationActionAttempts)
    .values({ ...input, status: "running" })
    .onConflictDoNothing()
    .returning({ id: automationActionAttempts.id });
  if (rows[0]) return { id: rows[0].id, status: "started" };
  const existing = await getDatabase()
    .select({
      externalReference: automationActionAttempts.externalReference,
      id: automationActionAttempts.id,
      status: automationActionAttempts.status,
    })
    .from(automationActionAttempts)
    .where(eq(automationActionAttempts.idempotencyKey, input.idempotencyKey))
    .limit(1);
  if (existing[0]?.status === "succeeded") {
    return {
      externalReference: existing[0].externalReference,
      id: existing[0].id,
      status: "existing_succeeded",
    };
  }
  throw new Error("Automation action has an unresolved prior attempt");
}

export async function completeAutomationActionAttempt(input: {
  attemptId: string;
  externalReference: string;
}): Promise<void> {
  await getDatabase()
    .update(automationActionAttempts)
    .set({
      externalReference: input.externalReference,
      status: "succeeded",
      updatedAt: new Date(),
    })
    .where(eq(automationActionAttempts.id, input.attemptId));
}

export async function failAutomationActionAttempt(input: {
  attemptId: string;
  failureMessage: string;
}): Promise<void> {
  await getDatabase()
    .update(automationActionAttempts)
    .set({
      failureMessage: input.failureMessage,
      status: "failed",
      updatedAt: new Date(),
    })
    .where(eq(automationActionAttempts.id, input.attemptId));
}

export async function setAutomationRunStatus(input: {
  failureCategory?: string;
  failureMessage?: string;
  leaseId?: string;
  resultSummary?: string;
  runId: string;
  status: AutomationRunStatus;
  usage?: Record<string, unknown>;
}): Promise<boolean> {
  const terminal = ["succeeded", "failed", "cancelled"].includes(input.status);
  const rows = await getDatabase()
    .update(automationRuns)
    .set({
      ...(terminal ? { completedAt: new Date() } : {}),
      ...(input.status === "running" ? { startedAt: new Date() } : {}),
      failureCategory: input.failureCategory,
      failureMessage: input.failureMessage,
      resultSummary: input.resultSummary,
      status: input.status,
      updatedAt: new Date(),
      usage: input.usage,
    })
    .where(
      and(
        eq(automationRuns.id, input.runId),
        ...(input.leaseId ? [eq(automationRuns.leaseId, input.leaseId)] : []),
      ),
    )
    .returning({ id: automationRuns.id });
  return rows.length > 0;
}

export async function claimAutomationRun(runId: string) {
  const db = getDatabase();
  const now = new Date();
  const leaseId = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + 60_000);
  const claimed = await db
    .update(automationRuns)
    .set({
      heartbeatAt: now,
      leaseId,
      leaseExpiresAt,
      startedAt: now,
      status: "running",
      updatedAt: now,
    })
    .where(
      and(
        eq(automationRuns.id, runId),
        or(
          eq(automationRuns.status, "pending"),
          and(
            eq(automationRuns.status, "running"),
            or(
              isNull(automationRuns.leaseExpiresAt),
              lt(automationRuns.leaseExpiresAt, now),
            ),
          ),
        ),
      ),
    )
    .returning({
      automationId: automationRuns.automationId,
      automationVersionId: automationRuns.automationVersionId,
      organizationId: automationRuns.organizationId,
      leaseId: automationRuns.leaseId,
      triggerInput: automationRuns.triggerInput,
    });
  const run = claimed[0];
  if (!run?.leaseId) return null;

  const rows = await db
    .select({
      cancelRequestedAt: automationRuns.cancelRequestedAt,
      harness: automationVersions.harness,
      maxModelRequests: automationVersions.maxModelRequests,
      maxOutputTokensPerRequest:
        automationVersions.maxOutputTokensPerRequest,
      maxRuntimeSeconds: automationVersions.maxRuntimeSeconds,
      model: automationVersions.model,
      modelCredentialId: automationVersions.modelCredentialId,
      modelProvider: automationVersions.modelProvider,
      prompt: automationVersions.prompt,
      toolPolicy: automationVersions.toolPolicy,
      trigger: automationVersions.trigger,
    })
    .from(automationRuns)
    .innerJoin(
      automations,
      and(
        eq(automations.id, automationRuns.automationId),
        eq(automations.enabled, true),
      ),
    )
    .innerJoin(
      organizationCapabilities,
      and(
        eq(
          organizationCapabilities.organizationId,
          automationRuns.organizationId,
        ),
        eq(organizationCapabilities.capability, "automations"),
        eq(organizationCapabilities.enabled, true),
      ),
    )
    .innerJoin(
      automationVersions,
      eq(automationVersions.id, automationRuns.automationVersionId),
    )
    .where(eq(automationRuns.id, runId))
    .limit(1);
  const configuration = rows[0];
  if (!configuration) {
    await setAutomationRunStatus({
      failureCategory: "configuration_unavailable",
      failureMessage: "Automation configuration is unavailable",
      leaseId,
      runId,
      status: "failed",
    });
    return null;
  }
  return { ...run, ...configuration, leaseId, runId };
}

export async function automationRunCancellationRequested(
  runId: string,
): Promise<boolean> {
  const rows = await getDatabase()
    .select({ cancelRequestedAt: automationRuns.cancelRequestedAt })
    .from(automationRuns)
    .where(eq(automationRuns.id, runId))
    .limit(1);
  return Boolean(rows[0]?.cancelRequestedAt);
}

export async function heartbeatAutomationRun(
  input: { leaseId: string; runId: string },
  leaseSeconds = 60,
): Promise<boolean> {
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 600) {
    throw new Error("Automation run lease must be between 30 and 600 seconds");
  }
  const now = new Date();
  const rows = await getDatabase()
    .update(automationRuns)
    .set({
      heartbeatAt: now,
      leaseExpiresAt: new Date(now.getTime() + leaseSeconds * 1_000),
      updatedAt: now,
    })
    .where(
      and(
        eq(automationRuns.id, input.runId),
        eq(automationRuns.leaseId, input.leaseId),
        eq(automationRuns.status, "running"),
      ),
    )
    .returning({ id: automationRuns.id });
  return rows.length > 0;
}

export async function getAutomationRuntimeRepositories(versionId: string) {
  const rows = await getDatabase()
    .select({
      defaultBranch: repositories.defaultBranch,
      fullName: repositories.fullName,
      installationId: integrationAccounts.externalAccountId,
      private: repositories.private,
    })
    .from(automationVersionRepositories)
    .innerJoin(
      automationVersions,
      eq(automationVersions.id, automationVersionRepositories.automationVersionId),
    )
    .innerJoin(
      automations,
      eq(automations.id, automationVersions.automationId),
    )
    .innerJoin(
      repositories,
      eq(repositories.id, automationVersionRepositories.repositoryId),
    )
    .innerJoin(
      integrationAccounts,
      and(
        eq(integrationAccounts.id, repositories.integrationAccountId),
        eq(integrationAccounts.organizationId, automations.organizationId),
        eq(integrationAccounts.provider, "github"),
        eq(integrationAccounts.status, "connected"),
      ),
    )
    .where(eq(automationVersionRepositories.automationVersionId, versionId));
  return rows.map((repository) => {
    const installationId = Number(repository.installationId);
    if (!Number.isSafeInteger(installationId) || installationId <= 0) {
      throw new Error("Automation repository installation is invalid");
    }
    return { ...repository, installationId };
  });
}

export async function getAutomationRuntimeConnections(versionId: string) {
  return getDatabase()
    .select({
      encryptedCredentials: integrationAccounts.encryptedCredentials,
      externalAccountId: integrationAccounts.externalAccountId,
      id: integrationAccounts.id,
      metadata: integrationAccounts.metadata,
      provider: integrationAccounts.provider,
      role: automationVersionIntegrationAccounts.role,
    })
    .from(automationVersionIntegrationAccounts)
    .innerJoin(
      automationVersions,
      eq(
        automationVersions.id,
        automationVersionIntegrationAccounts.automationVersionId,
      ),
    )
    .innerJoin(
      automations,
      eq(automations.id, automationVersions.automationId),
    )
    .innerJoin(
      integrationAccounts,
      and(
        eq(
          integrationAccounts.id,
          automationVersionIntegrationAccounts.integrationAccountId,
        ),
        eq(integrationAccounts.organizationId, automations.organizationId),
        eq(integrationAccounts.status, "connected"),
      ),
    )
    .where(
      eq(
        automationVersionIntegrationAccounts.automationVersionId,
        versionId,
      ),
    );
}
