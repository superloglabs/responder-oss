import { randomUUID } from "node:crypto";
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import type {
  AutomationConfiguration,
  AutomationInferenceSource,
  AutomationInput,
  AutomationTrigger,
} from "../automations/config.js";
import { supportsIncludedUsage } from "../automations/model-pricing.js";
import type { AutomationUserMessageEventData } from "../automations/transcript.js";
import { getDatabase } from "./client.js";
import {
  automationModelUsage,
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

// Returns the inference source implied by the selected model credential.
async function validateConfigurationResources(
  tx: AutomationTransaction,
  organizationId: string,
  configuration: AutomationConfiguration,
): Promise<AutomationInferenceSource> {
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

  let inferenceSource: AutomationInferenceSource = "responder";
  if (!configuration.modelCredentialId && !supportsIncludedUsage(configuration.modelProvider)) {
    throw new AutomationConfigurationError(
      "This provider needs a model connection",
      "credential_not_found",
    );
  }
  if (configuration.modelCredentialId) {
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
    inferenceSource = credentialRows[0].authType === "chatgpt_subscription"
      ? "byos"
      : "byok";
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
  return inferenceSource;
}

async function insertAutomationVersion(
  tx: AutomationTransaction,
  input: {
    automationId: string;
    configuration: AutomationConfiguration;
    createdBy: string;
    inferenceSource: AutomationInferenceSource;
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
      inferenceSource: input.inferenceSource,
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
      input.configuration.repositoryIds.map((repositoryId, position) => ({
        automationVersionId: versionId,
        position,
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
    const inferenceSource = await validateConfigurationResources(
      tx,
      organizationId,
      input.configuration,
    );
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
      inferenceSource,
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
    const inferenceSource = await validateConfigurationResources(
      tx,
      organizationId,
      input.configuration,
    );
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
      inferenceSource,
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
  const db = getDatabase();
  const rows = await db
    .select({
      createdAt: automations.createdAt,
      description: automations.description,
      enabled: automations.enabled,
      harness: automationVersions.harness,
      id: automations.id,
      inferenceSource: automationVersions.inferenceSource,
      model: automationVersions.model,
      modelProvider: automationVersions.modelProvider,
      name: automations.name,
      trigger: automationVersions.trigger,
      updatedAt: automations.updatedAt,
      version: automationVersions.version,
      versionId: automationVersions.id,
    })
    .from(automations)
    .innerJoin(
      automationVersions,
      eq(automationVersions.id, automations.activeVersionId),
    )
    .where(eq(automations.organizationId, organizationId))
    .orderBy(desc(automations.updatedAt));
  if (rows.length === 0) return [];
  const versionIds = rows.map((row) => row.versionId);
  const [accountRows, repositoryRows, runRows] = await Promise.all([
    db
      .select({
        provider: integrationAccounts.provider,
        versionId: automationVersionIntegrationAccounts.automationVersionId,
      })
      .from(automationVersionIntegrationAccounts)
      .innerJoin(
        integrationAccounts,
        eq(
          integrationAccounts.id,
          automationVersionIntegrationAccounts.integrationAccountId,
        ),
      )
      .where(
        and(
          inArray(automationVersionIntegrationAccounts.automationVersionId, versionIds),
          eq(automationVersionIntegrationAccounts.role, "context"),
        ),
      ),
    db
      .selectDistinct({ versionId: automationVersionRepositories.automationVersionId })
      .from(automationVersionRepositories)
      .where(inArray(automationVersionRepositories.automationVersionId, versionIds)),
    db
      .selectDistinctOn([automationRuns.automationId], {
        automationId: automationRuns.automationId,
        createdAt: automationRuns.createdAt,
        status: automationRuns.status,
      })
      .from(automationRuns)
      .where(
        and(
          eq(automationRuns.organizationId, organizationId),
          inArray(automationRuns.automationId, rows.map((row) => row.id)),
        ),
      )
      .orderBy(automationRuns.automationId, desc(automationRuns.createdAt)),
  ]);
  return summarizeAutomationList(rows, { accountRows, repositoryRows, runRows });
}

// Connectors list GitHub first when the version has repositories, followed by
// each distinct context provider in alphabetical order.
export function summarizeAutomationList<
  Row extends { id: string; versionId: string },
>(
  rows: Row[],
  links: {
    accountRows: Array<{ provider: string; versionId: string }>;
    repositoryRows: Array<{ versionId: string }>;
    runRows: Array<{ automationId: string; createdAt: Date; status: AutomationRunStatus }>;
  },
) {
  const connectors = new Map<string, Set<string>>();
  for (const { versionId } of links.repositoryRows) {
    connectors.set(versionId, new Set(["github"]));
  }
  const accountRows = [...links.accountRows].sort((left, right) =>
    left.provider.localeCompare(right.provider),
  );
  for (const { provider, versionId } of accountRows) {
    const providers = connectors.get(versionId) ?? new Set<string>();
    providers.add(provider);
    connectors.set(versionId, providers);
  }
  const lastRuns = new Map(
    links.runRows.map(({ automationId, ...run }) => [automationId, run]),
  );
  return rows.map(({ versionId, ...row }) => ({
    ...row,
    connectors: [...(connectors.get(versionId) ?? [])],
    lastRun: lastRuns.get(row.id) ?? null,
  }));
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
      inferenceSource: automationVersions.inferenceSource,
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
  const [accountRows, repositoryRows, secretRows, runPage] = await Promise.all([
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
      )
      .orderBy(
        automationVersionRepositories.position,
        automationVersionRepositories.repositoryId,
      ),
    db
      .select({ id: automationVersionSecrets.workspaceSecretId })
      .from(automationVersionSecrets)
      .where(
        eq(automationVersionSecrets.automationVersionId, automation.versionId),
      ),
    listAutomationRuns(organizationId, automationId, { limit: 50, offset: 0 }),
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
    runs: runPage.runs,
  };
}

// Returns one page of an automation's runs, newest first. Each run carries
// its position in the automation's history and the trigger's display fields.
export async function listAutomationRuns(
  organizationId: string,
  automationId: string,
  page: { limit: number; offset: number },
) {
  const db = getDatabase();
  const scope = and(
    eq(automationRuns.automationId, automationId),
    eq(automationRuns.organizationId, organizationId),
  );
  const [runRows, totals] = await Promise.all([
    db
      .select({
        completedAt: automationRuns.completedAt,
        createdAt: automationRuns.createdAt,
        failureCategory: automationRuns.failureCategory,
        failureMessage: automationRuns.failureMessage,
        id: automationRuns.id,
        number: sql<string>`row_number() over (order by ${automationRuns.createdAt}, ${automationRuns.id})`,
        redactedTrigger: automationRuns.redactedTrigger,
        resultSummary: automationRuns.resultSummary,
        startedAt: automationRuns.startedAt,
        status: automationRuns.status,
        usage: automationRuns.usage,
      })
      .from(automationRuns)
      .where(scope)
      .orderBy(desc(automationRuns.createdAt), desc(automationRuns.id))
      .limit(page.limit)
      .offset(page.offset),
    db
      .select({ total: sql<string>`count(*)` })
      .from(automationRuns)
      .where(scope),
  ]);
  const inferenceUsage = await summarizeRunsInferenceUsage(
    runRows.map((run) => run.id),
  );
  return {
    runs: runRows.map(({ number, redactedTrigger, ...run }) => ({
      ...run,
      inferenceUsage: inferenceUsage.get(run.id) ?? null,
      number: Number(number),
      trigger: runTriggerSummary(redactedTrigger),
    })),
    total: Number(totals[0]?.total ?? 0),
  };
}

function runTriggerSummary(trigger: Record<string, unknown>): {
  provider: string;
  sourceUrl: string | null;
  title: string;
} {
  return {
    provider: typeof trigger.provider === "string" ? trigger.provider : "manual",
    sourceUrl: typeof trigger.sourceUrl === "string" ? trigger.sourceUrl : null,
    title: typeof trigger.title === "string" ? trigger.title : "Automation run",
  };
}

export interface AutomationRunInferenceUsage {
  // Null when any request's price is unknown.
  costMicros: number | null;
  inputTokens: number;
  outputTokens: number;
  requests: number;
}

async function summarizeRunsInferenceUsage(
  runIds: string[],
): Promise<Map<string, AutomationRunInferenceUsage>> {
  if (runIds.length === 0) return new Map();
  const rows = await getDatabase()
    .select({
      costMicros: sql<string | null>`case when bool_or(${automationModelUsage.costMicros} is null) then null else sum(${automationModelUsage.costMicros}) end`,
      inputTokens: sql<string>`sum(${automationModelUsage.inputTokens} + ${automationModelUsage.cachedInputTokens} + ${automationModelUsage.cacheWriteTokens})`,
      outputTokens: sql<string>`sum(${automationModelUsage.outputTokens})`,
      requests: sql<string>`count(*)`,
      runId: automationModelUsage.runId,
    })
    .from(automationModelUsage)
    .where(
      and(
        inArray(automationModelUsage.runId, runIds),
        isNotNull(automationModelUsage.completedAt),
      ),
    )
    .groupBy(automationModelUsage.runId);
  return new Map(rows.map((row) => [row.runId, {
    costMicros: row.costMicros === null ? null : Number(row.costMicros),
    inputTokens: Number(row.inputTokens),
    outputTokens: Number(row.outputTokens),
    requests: Number(row.requests),
  }]));
}

export async function getAutomationRun(
  organizationId: string,
  runId: string,
) {
  const db = getDatabase();
  const rows = await db
    .select({
      automationEnabled: automations.enabled,
      automationId: automationRuns.automationId,
      automationName: automations.name,
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
    .innerJoin(automations, eq(automations.id, automationRuns.automationId))
    .where(
      and(
        eq(automationRuns.id, runId),
        eq(automationRuns.organizationId, organizationId),
      ),
    )
    .limit(1);
  const run = rows[0];
  if (!run) return null;
  const [events, inferenceUsage, position] = await Promise.all([
    db
      .select()
      .from(automationRunEvents)
      .where(eq(automationRunEvents.runId, runId))
      .orderBy(automationRunEvents.id),
    summarizeRunsInferenceUsage([runId]),
    // Matches the numbering in listAutomationRuns.
    db
      .select({ number: sql<string>`count(*)` })
      .from(automationRuns)
      .where(
        and(
          eq(automationRuns.automationId, run.automationId),
          // Compared in SQL: a JavaScript date drops the microseconds.
          sql`(${automationRuns.createdAt}, ${automationRuns.id}) <= (select created_at, id from automation_runs where id = ${runId})`,
        ),
      ),
  ]);
  return {
    ...run,
    events,
    inferenceUsage: inferenceUsage.get(runId) ?? null,
    number: Number(position[0]?.number ?? 1),
    trigger: {
      ...runTriggerSummary(run.redactedTrigger),
      attributes: runTriggerAttributes(run.redactedTrigger),
    },
  };
}

function runTriggerAttributes(
  trigger: Record<string, unknown>,
): Record<string, string | number | boolean | null> {
  const attributes = trigger.attributes;
  if (typeof attributes !== "object" || attributes === null) return {};
  return Object.fromEntries(
    Object.entries(attributes).filter(([, value]) =>
      value === null || ["boolean", "number", "string"].includes(typeof value)
    ),
  ) as Record<string, string | number | boolean | null>;
}

// Follow-ups and transcripts from earlier turns, oldest first.
export async function listAutomationRunConversation(runId: string) {
  return getDatabase()
    .select({ data: automationRunEvents.data, type: automationRunEvents.type })
    .from(automationRunEvents)
    .where(
      and(
        eq(automationRunEvents.runId, runId),
        inArray(automationRunEvents.type, ["transcript", "user_message"]),
      ),
    )
    .orderBy(automationRunEvents.id);
}

// Queues another turn of a finished run for a workspace member's follow-up.
// Returns null when the run is missing, still active, or its automation is off.
export async function continueAutomationRun(input: {
  message: AutomationUserMessageEventData;
  organizationId: string;
  runId: string;
}): Promise<{ automationId: string } | null> {
  return getDatabase().transaction(async (tx) => {
    const rows = await tx
      .update(automationRuns)
      .set({
        cancelRequestedAt: null,
        completedAt: null,
        failureCategory: null,
        failureMessage: null,
        heartbeatAt: null,
        leaseExpiresAt: null,
        leaseId: null,
        resultSummary: null,
        status: "pending",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(automationRuns.id, input.runId),
          eq(automationRuns.organizationId, input.organizationId),
          inArray(automationRuns.status, ["succeeded", "failed", "cancelled"]),
          sql`exists (select 1 from ${automations} where ${automations.id} = ${automationRuns.automationId} and ${automations.enabled})`,
        ),
      )
      .returning({ automationId: automationRuns.automationId });
    const run = rows[0];
    if (!run) return null;
    await tx.insert(automationRunEvents).values({
      data: { ...input.message },
      runId: input.runId,
      type: "user_message",
    });
    return run;
  });
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
  // A test chat's first message, shown in the run transcript.
  message?: AutomationUserMessageEventData;
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
    if (receipts.length > 0) {
      if (input.message) {
        await tx.insert(automationRunEvents).values({
          data: { ...input.message },
          runId,
          type: "user_message",
        });
      }
      return { created: true, runId };
    }

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
}): Promise<number | undefined> {
  const rows = await getDatabase()
    .insert(automationRunEvents)
    .values(input)
    .returning({ id: automationRunEvents.id });
  return rows[0]?.id;
}

// Replaces the data of an event, such as a transcript that grows while the
// harness runs.
export async function updateAutomationRunEvent(input: {
  data: Record<string, unknown>;
  id: number;
  runId: string;
}): Promise<void> {
  await getDatabase()
    .update(automationRunEvents)
    .set({ data: input.data })
    .where(
      and(
        eq(automationRunEvents.id, input.id),
        eq(automationRunEvents.runId, input.runId),
      ),
    );
}

// Records the paused sandbox a follow-up resumes, or clears it when the
// sandbox was deleted.
export async function saveAutomationRunSandbox(input: {
  leaseId: string;
  runId: string;
  sandbox: { id: string; sessionState: Record<string, unknown> } | null;
}): Promise<void> {
  await getDatabase()
    .update(automationRuns)
    .set({
      sandboxId: input.sandbox?.id ?? null,
      sandboxSessionState: input.sandbox?.sessionState ?? null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(automationRuns.id, input.runId),
        eq(automationRuns.leaseId, input.leaseId),
      ),
    );
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
      // A follow-up turn keeps the run's original start time.
      startedAt: sql`coalesce(${automationRuns.startedAt}, ${now})`,
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
      sandboxSessionState: automationRuns.sandboxSessionState,
      triggerInput: automationRuns.triggerInput,
    });
  const run = claimed[0];
  if (!run?.leaseId) return null;

  const rows = await db
    .select({
      cancelRequestedAt: automationRuns.cancelRequestedAt,
      harness: automationVersions.harness,
      inferenceSource: automationVersions.inferenceSource,
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
    .where(eq(automationVersionRepositories.automationVersionId, versionId))
    .orderBy(
      automationVersionRepositories.position,
      automationVersionRepositories.repositoryId,
    );
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
