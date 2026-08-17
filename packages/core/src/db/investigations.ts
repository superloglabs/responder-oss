import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, lt, or } from "drizzle-orm";
import { z } from "zod";
import {
  decryptCredentials,
  encryptCredentials,
} from "../credentials/encryption.js";
import {
  DATADOG_OAUTH_RESOURCE,
  getDatadogSite,
  type DatadogDatacenter,
  type DatadogSiteId,
} from "../integrations/datadog.js";
import {
  parseCustomMcpCredentials,
  refreshCustomMcpOAuth,
} from "../integrations/custom-mcp.js";
import {
  CLICKSTACK_CLOUD_MCP_URL,
  CLICKSTACK_CLOUD_OAUTH_ISSUER,
  CLICKSTACK_CLOUD_OAUTH_RESOURCE,
  logClickStackTokenRefreshFailure,
  normalizeClickStackMcpUrl,
} from "../integrations/clickstack.js";
import {
  type LinearOAuthCredentials,
  linearAccessTokenNeedsRefresh,
  LINEAR_READONLY_MCP_URL,
  parseLinearOAuthCredentials,
  refreshLinearOAuthCredentials,
} from "../integrations/linear.js";
import { SLACK_MCP_URL } from "../integrations/slack-mcp.js";
import type { InvestigationReportSubmission } from "../investigations/report.js";
import { getDatabase } from "./client.js";
import {
  agentConfigVersions,
  agentVersionRepositories,
  agents,
  instanceConfiguration,
  integrationAccounts,
  integrationResources,
  investigationIssues,
  investigationReplayRequests,
  investigationTraceEvents,
  investigations,
  issues,
  repositories,
  runtimeProfiles,
  webhookReceipts,
  type InvestigationInput,
  type InvestigationSlackTraceItem,
  type InvestigationTraceEvent,
  type AgentPrMode,
} from "./schema.js";
import { getInvestigationIssueDetails } from "./issues.js";

export interface RuntimeAgentConfig {
  id: string;
  agentId: string;
  organizationId: string;
  model: string;
  prompt: string;
  prMode: AgentPrMode;
  createLinearTickets: boolean;
  linearIssueTemplate: string;
}

export interface RuntimeRepository {
  defaultBranch: string;
  fullName: string;
  installationId: number;
  private: boolean;
}

export interface RuntimeSlackConnection {
  accountId: string;
  channels: Array<{ id: string; name: string }>;
  mcpUrl: string;
  userAccessToken: string;
}

export interface BeginInvestigationResult {
  created: boolean;
  investigationId: string;
  runtimeProfileId: string;
  config: RuntimeAgentConfig;
}

export class InstanceRuntimeProfileError extends Error {
  constructor() {
    super("The Responder instance does not have an active runtime profile");
    this.name = "InstanceRuntimeProfileError";
  }
}

export function investigationCanBeRetried(
  status: "pending" | "investigating" | "resolved" | "failed",
): boolean {
  return status === "resolved" || status === "failed";
}

export class InvestigationRetryError extends Error {
  constructor(
    public readonly code: "not_found" | "not_retryable",
    message: string,
  ) {
    super(message);
    this.name = "InvestigationRetryError";
  }
}

export async function getInvestigationForRetry(input: {
  organizationId: string;
  agentId: string;
  investigationId: string;
}) {
  const rows = await getDatabase()
    .select({
      id: investigations.id,
      status: investigations.status,
      input: investigations.input,
    })
    .from(investigations)
    .where(
      and(
        eq(investigations.id, input.investigationId),
        eq(investigations.agentId, input.agentId),
        eq(investigations.organizationId, input.organizationId),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

export async function getInvestigationDetail(input: {
  organizationId: string;
  agentId: string;
  investigationId: string;
}) {
  const rows = await getDatabase()
    .select({
      id: investigations.id,
      agentId: investigations.agentId,
      runtimeProfileId: investigations.runtimeProfileId,
      status: investigations.status,
      title: investigations.title,
      input: investigations.input,
      finding: investigations.finding,
      structuredReport: investigations.structuredReport,
      replayReport: investigations.replayReport,
      reportMarkdown: investigations.reportMarkdown,
      isReplay: investigations.isReplay,
      replayOfInvestigationId: investigations.replayOfInvestigationId,
      eveSessionId: investigations.eveSessionId,
      failureReason: investigations.failureReason,
      startedAt: investigations.startedAt,
      completedAt: investigations.completedAt,
      createdAt: investigations.createdAt,
      updatedAt: investigations.updatedAt,
    })
    .from(investigations)
    .where(
      and(
        eq(investigations.id, input.investigationId),
        eq(investigations.agentId, input.agentId),
        eq(investigations.organizationId, input.organizationId),
      ),
    )
    .limit(1);

  const investigation = rows[0];
  if (!investigation) return null;
  return {
    ...investigation,
    finding: investigation.finding
      ? {
          summary: investigation.finding.summary,
          remediation: investigation.finding.remediation,
          evidence: investigation.finding.evidence,
          ...(investigation.finding.pullRequestUrl
            ? { pullRequestUrl: investigation.finding.pullRequestUrl }
            : {}),
        }
      : null,
    structuredReport: investigation.structuredReport
      ? {
          schemaVersion: 1 as const,
          headline: investigation.structuredReport.headline,
          summary: investigation.structuredReport.summary,
          issues: investigation.structuredReport.issues,
        }
      : null,
    issues: await getInvestigationIssueDetails(investigation.id),
  };
}

export async function getInvestigationTraceSession(
  investigationId: string,
): Promise<string | null> {
  const rows = await getDatabase()
    .select({ eveSessionId: investigations.eveSessionId })
    .from(investigations)
    .where(eq(investigations.id, investigationId))
    .limit(1);

  return rows[0]?.eveSessionId ?? null;
}

export async function recordInvestigationSlackMessage(
  investigationId: string,
  messageTimestamp: string,
): Promise<"pending" | "investigating" | "resolved" | "failed"> {
  const rows = await getDatabase()
    .update(investigations)
    .set({
      slackMessageTimestamp: messageTimestamp,
      updatedAt: new Date(),
    })
    .where(eq(investigations.id, investigationId))
    .returning({ status: investigations.status });
  const investigation = rows[0];
  if (!investigation) throw new Error("Investigation not found");
  return investigation.status;
}

export async function recordInvestigationSlackTrace(
  investigationId: string,
  traceItems: InvestigationSlackTraceItem[],
): Promise<void> {
  await getDatabase()
    .update(investigations)
    .set({
      slackTraceItems: traceItems,
      updatedAt: new Date(),
    })
    .where(eq(investigations.id, investigationId));
}

const investigationTracePageSize = 500;

export async function appendInvestigationTraceEvent(
  investigationId: string,
  event: InvestigationTraceEvent,
): Promise<void> {
  await getDatabase().insert(investigationTraceEvents).values({
    investigationId,
    event,
  });
}

export async function listInvestigationTraceEvents(
  investigationId: string,
): Promise<{
  events: InvestigationTraceEvent[];
  truncated: boolean;
}> {
  const rows = await getDatabase()
    .select({ event: investigationTraceEvents.event })
    .from(investigationTraceEvents)
    .where(eq(investigationTraceEvents.investigationId, investigationId))
    .orderBy(desc(investigationTraceEvents.id))
    .limit(investigationTracePageSize + 1);
  const truncated = rows.length > investigationTracePageSize;
  return {
    events: rows
      .slice(0, investigationTracePageSize)
      .reverse()
      .map((row) => row.event),
    truncated,
  };
}

export async function prepareInvestigationRetry(
  investigationId: string,
): Promise<{
  investigationId: string;
  input: InvestigationInput;
  runtimeProfileId: string;
  config: RuntimeAgentConfig;
}> {
  const db = getDatabase();
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: investigations.id,
        input: investigations.input,
        status: investigations.status,
        configId: agentConfigVersions.id,
        agentId: agentConfigVersions.agentId,
        organizationId: agents.organizationId,
        model: agentConfigVersions.model,
        prMode: agentConfigVersions.prMode,
        prompt: agentConfigVersions.prompt,
        createLinearTickets: agentConfigVersions.createLinearTickets,
        linearIssueTemplate: agentConfigVersions.linearIssueTemplate,
      })
      .from(investigations)
      .innerJoin(
        agentConfigVersions,
        eq(agentConfigVersions.id, investigations.agentConfigVersionId),
      )
      .innerJoin(agents, eq(agents.id, investigations.agentId))
      .where(eq(investigations.id, investigationId))
      .limit(1);
    const investigation = rows[0];

    if (!investigation) {
      throw new InvestigationRetryError(
        "not_found",
        "Investigation not found",
      );
    }
    if (!investigationCanBeRetried(investigation.status)) {
      throw new InvestigationRetryError(
        "not_retryable",
        "Only finished investigations can be retried",
      );
    }

    const activeProfiles = await tx
      .select({ id: runtimeProfiles.id })
      .from(instanceConfiguration)
      .innerJoin(
        runtimeProfiles,
        eq(runtimeProfiles.id, instanceConfiguration.activeRuntimeProfileId),
      )
      .where(eq(instanceConfiguration.id, "default"))
      .limit(1);
    const activeProfile = activeProfiles[0];
    if (!activeProfile) throw new InstanceRuntimeProfileError();

    const previousLinks = await tx
      .select({
        issueId: investigationIssues.issueId,
        relationship: investigationIssues.relationship,
      })
      .from(investigationIssues)
      .where(eq(investigationIssues.investigationId, investigationId));
    await tx
      .delete(investigationIssues)
      .where(eq(investigationIssues.investigationId, investigationId));
    for (const link of previousLinks) {
      if (link.relationship !== "new") continue;
      const remainingLinks = await tx
        .select({ issueId: investigationIssues.issueId })
        .from(investigationIssues)
        .where(eq(investigationIssues.issueId, link.issueId))
        .limit(1);
      if (remainingLinks.length === 0) {
        await tx
          .delete(issues)
          .where(
            and(
              eq(issues.id, link.issueId),
              eq(issues.organizationId, investigation.organizationId),
            ),
          );
      }
    }

    await tx
      .delete(investigationTraceEvents)
      .where(eq(investigationTraceEvents.investigationId, investigationId));

    const reset = await tx
      .update(investigations)
      .set({
        status: "pending",
        finding: null,
        structuredReport: null,
        reportMarkdown: null,
        eveSessionId: null,
        failureReason: null,
        startedAt: null,
        completedAt: null,
        runtimeProfileId: activeProfile.id,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(investigations.id, investigationId),
          inArray(investigations.status, ["failed", "resolved"]),
        ),
      )
      .returning({ id: investigations.id });

    if (!reset[0]) {
      throw new InvestigationRetryError(
        "not_retryable",
        "Only finished investigations can be retried",
      );
    }

    return {
      investigationId,
      input: investigation.input,
      runtimeProfileId: activeProfile.id,
      config: {
        id: investigation.configId,
        agentId: investigation.agentId,
        organizationId: investigation.organizationId,
        model: investigation.model,
        prompt: investigation.prompt,
        prMode: investigation.prMode,
        createLinearTickets: investigation.createLinearTickets,
        linearIssueTemplate: investigation.linearIssueTemplate,
      },
    };
  });
}

export async function prepareInvestigationReplay(input: {
  investigationId: string;
  organizationId: string;
  agentId: string;
  replayInvestigationId?: string;
}): Promise<{
  created: boolean;
  investigationId: string;
  input: InvestigationInput;
  replayStatus: "pending" | "investigating" | "resolved" | "failed";
  runtimeProfileId: string;
  config: RuntimeAgentConfig;
}> {
  const db = getDatabase();
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        input: investigations.input,
        status: investigations.status,
        configId: agentConfigVersions.id,
        agentId: agentConfigVersions.agentId,
        organizationId: agents.organizationId,
        model: agentConfigVersions.model,
        prMode: agentConfigVersions.prMode,
        prompt: agentConfigVersions.prompt,
        createLinearTickets: agentConfigVersions.createLinearTickets,
        linearIssueTemplate: agentConfigVersions.linearIssueTemplate,
        title: investigations.title,
      })
      .from(investigations)
      .innerJoin(
        agentConfigVersions,
        eq(agentConfigVersions.id, investigations.agentConfigVersionId),
      )
      .innerJoin(agents, eq(agents.id, investigations.agentId))
      .where(
        and(
          eq(investigations.id, input.investigationId),
          eq(investigations.agentId, input.agentId),
          eq(investigations.organizationId, input.organizationId),
        ),
      )
      .limit(1);
    const source = rows[0];
    if (!source) {
      throw new InvestigationRetryError("not_found", "Investigation not found");
    }
    if (!investigationCanBeRetried(source.status)) {
      throw new InvestigationRetryError(
        "not_retryable",
        "Only finished investigations can be replayed",
      );
    }

    const activeProfiles = await tx
      .select({ id: runtimeProfiles.id })
      .from(instanceConfiguration)
      .innerJoin(
        runtimeProfiles,
        eq(runtimeProfiles.id, instanceConfiguration.activeRuntimeProfileId),
      )
      .where(eq(instanceConfiguration.id, "default"))
      .limit(1);
    const activeProfile = activeProfiles[0];
    if (!activeProfile) throw new InstanceRuntimeProfileError();

    const replayId = input.replayInvestigationId ?? randomUUID();
    const existingRows = await tx
      .select({
        id: investigations.id,
        isReplay: investigations.isReplay,
        replayOfInvestigationId: investigations.replayOfInvestigationId,
        runtimeProfileId: investigations.runtimeProfileId,
        status: investigations.status,
      })
      .from(investigations)
      .where(eq(investigations.id, replayId))
      .limit(1);
    const existing = existingRows[0];
    if (
      existing &&
      (!existing.isReplay ||
        existing.replayOfInvestigationId !== input.investigationId)
    ) {
      throw new Error("Replay investigation ID is already in use");
    }
    if (!existing) {
      await tx.insert(investigations).values({
        id: replayId,
        organizationId: source.organizationId,
        agentId: source.agentId,
        agentConfigVersionId: source.configId,
        runtimeProfileId: activeProfile.id,
        title: source.title,
        input: source.input,
        isReplay: true,
        replayOfInvestigationId: input.investigationId,
      });
    }

    return {
      created: !existing,
      investigationId: replayId,
      replayStatus: existing?.status ?? "pending",
      input: source.input,
      runtimeProfileId: existing?.runtimeProfileId ?? activeProfile.id,
      config: {
        id: source.configId,
        agentId: source.agentId,
        organizationId: source.organizationId,
        model: source.model,
        prompt: source.prompt,
        prMode: source.prMode,
        createLinearTickets: source.createLinearTickets,
        linearIssueTemplate: source.linearIssueTemplate,
      },
    };
  });
}

export interface ClaimedInvestigationReplayRequest {
  attemptCount: number;
  id: string;
  replayInvestigationId: string;
  requestedBy: string;
  sourceInvestigationId: string;
}

const replayRequestLeaseMs = 5 * 60 * 1_000;
const replayRequestMaxAttempts = 5;

export async function claimInvestigationReplayRequest(): Promise<
  ClaimedInvestigationReplayRequest | { exhausted: true } | null
> {
  return getDatabase().transaction(async (tx) => {
    const staleBefore = new Date(Date.now() - replayRequestLeaseMs);
    const exhaustedRows = await tx
      .select({
        id: investigationReplayRequests.id,
        replayInvestigationId:
          investigationReplayRequests.replayInvestigationId,
      })
      .from(investigationReplayRequests)
      .where(
        and(
          eq(investigationReplayRequests.status, "processing"),
          gte(
            investigationReplayRequests.attemptCount,
            replayRequestMaxAttempts,
          ),
          lt(investigationReplayRequests.processingStartedAt, staleBefore),
        ),
      )
      .orderBy(investigationReplayRequests.createdAt)
      .limit(1)
      .for("update", { skipLocked: true });
    const exhausted = exhaustedRows[0];
    if (exhausted) {
      const completedAt = new Date();
      const failureReason =
        "Replay request stopped responding after its final attempt";
      await tx
        .update(investigationReplayRequests)
        .set({
          completedAt,
          failureReason,
          processingStartedAt: null,
          status: "failed",
          updatedAt: completedAt,
        })
        .where(eq(investigationReplayRequests.id, exhausted.id));
      await tx
        .update(investigations)
        .set({
          completedAt,
          failureReason,
          status: "failed",
          updatedAt: completedAt,
        })
        .where(
          and(
            eq(investigations.id, exhausted.replayInvestigationId),
            eq(investigations.status, "pending"),
          ),
        );
      return { exhausted: true as const };
    }

    const rows = await tx
      .select({
        attemptCount: investigationReplayRequests.attemptCount,
        id: investigationReplayRequests.id,
        replayInvestigationId:
          investigationReplayRequests.replayInvestigationId,
        requestedBy: investigationReplayRequests.requestedBy,
        sourceInvestigationId:
          investigationReplayRequests.sourceInvestigationId,
      })
      .from(investigationReplayRequests)
      .where(
        and(
          lt(
            investigationReplayRequests.attemptCount,
            replayRequestMaxAttempts,
          ),
          or(
            eq(investigationReplayRequests.status, "pending"),
            and(
              eq(investigationReplayRequests.status, "processing"),
              lt(
                investigationReplayRequests.processingStartedAt,
                staleBefore,
              ),
            ),
          ),
        ),
      )
      .orderBy(investigationReplayRequests.createdAt)
      .limit(1)
      .for("update", { skipLocked: true });
    const request = rows[0];
    if (!request) return null;

    const attemptCount = request.attemptCount + 1;
    await tx
      .update(investigationReplayRequests)
      .set({
        attemptCount,
        failureReason: null,
        processingStartedAt: new Date(),
        status: "processing",
        updatedAt: new Date(),
      })
      .where(eq(investigationReplayRequests.id, request.id));
    return { ...request, attemptCount };
  });
}

export async function prepareInvestigationReplayRequest(
  request: ClaimedInvestigationReplayRequest,
) {
  const sourceRows = await getDatabase()
    .select({
      agentId: investigations.agentId,
      organizationId: investigations.organizationId,
    })
    .from(investigations)
    .where(eq(investigations.id, request.sourceInvestigationId))
    .limit(1);
  const source = sourceRows[0];
  if (!source) {
    throw new InvestigationRetryError("not_found", "Investigation not found");
  }
  return prepareInvestigationReplay({
    agentId: source.agentId,
    investigationId: request.sourceInvestigationId,
    organizationId: source.organizationId,
    replayInvestigationId: request.replayInvestigationId,
  });
}

export async function markInvestigationReplayRequestQueued(
  requestId: string,
): Promise<void> {
  await getDatabase()
    .update(investigationReplayRequests)
    .set({
      processingStartedAt: null,
      queuedAt: new Date(),
      status: "queued",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(investigationReplayRequests.id, requestId),
        eq(investigationReplayRequests.status, "processing"),
      ),
    );
}

export async function releaseInvestigationReplayRequest(
  request: ClaimedInvestigationReplayRequest,
  reason: string,
): Promise<{ failed: boolean }> {
  const failed = request.attemptCount >= replayRequestMaxAttempts;
  await getDatabase()
    .update(investigationReplayRequests)
    .set({
      failureReason: failed ? reason.slice(0, 2_000) : null,
      processingStartedAt: null,
      status: failed ? "failed" : "pending",
      updatedAt: new Date(),
      ...(failed ? { completedAt: new Date() } : {}),
    })
    .where(
      and(
        eq(investigationReplayRequests.id, request.id),
        eq(investigationReplayRequests.status, "processing"),
      ),
    );
  return { failed };
}

export async function completeInvestigationReplayRequest(
  replayInvestigationId: string,
): Promise<void> {
  await getDatabase()
    .update(investigationReplayRequests)
    .set({
      completedAt: new Date(),
      failureReason: null,
      status: "completed",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(
          investigationReplayRequests.replayInvestigationId,
          replayInvestigationId,
        ),
        inArray(investigationReplayRequests.status, [
          "pending",
          "processing",
          "queued",
          "failed",
        ]),
      ),
    );
}

export async function failInvestigationReplayRequest(
  replayInvestigationId: string,
  reason: string,
): Promise<void> {
  await getDatabase()
    .update(investigationReplayRequests)
    .set({
      completedAt: new Date(),
      failureReason: reason.slice(0, 2_000),
      processingStartedAt: null,
      status: "failed",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(
          investigationReplayRequests.replayInvestigationId,
          replayInvestigationId,
        ),
        inArray(investigationReplayRequests.status, [
          "pending",
          "processing",
          "queued",
        ]),
      ),
    );
}

export async function saveInvestigationReplayReport(input: {
  investigationId: string;
  organizationId: string;
  report: InvestigationReportSubmission;
}): Promise<void> {
  const updated = await getDatabase()
    .update(investigations)
    .set({ replayReport: input.report, updatedAt: new Date() })
    .where(
      and(
        eq(investigations.id, input.investigationId),
        eq(investigations.organizationId, input.organizationId),
        eq(investigations.isReplay, true),
        inArray(investigations.status, ["pending", "investigating"]),
      ),
    )
    .returning({ id: investigations.id });
  if (!updated[0]) throw new Error("Replay investigation is unavailable");
}

export async function getRuntimeAgentConfig(
  versionId: string,
): Promise<RuntimeAgentConfig | null> {
  const db = getDatabase();
  const rows = await db
    .select({
      id: agentConfigVersions.id,
      agentId: agentConfigVersions.agentId,
      organizationId: agents.organizationId,
      model: agentConfigVersions.model,
      prompt: agentConfigVersions.prompt,
      prMode: agentConfigVersions.prMode,
      createLinearTickets: agentConfigVersions.createLinearTickets,
      linearIssueTemplate: agentConfigVersions.linearIssueTemplate,
    })
    .from(agentConfigVersions)
    .innerJoin(agents, eq(agents.id, agentConfigVersions.agentId))
    .where(eq(agentConfigVersions.id, versionId))
    .limit(1);

  return rows[0] ?? null;
}

export async function getRuntimeRepositories(
  versionId: string,
): Promise<RuntimeRepository[]> {
  const rows = await getDatabase()
    .select({
      defaultBranch: repositories.defaultBranch,
      fullName: repositories.fullName,
      installationId: integrationAccounts.externalAccountId,
      private: repositories.private,
    })
    .from(agentConfigVersions)
    .innerJoin(agents, eq(agents.id, agentConfigVersions.agentId))
    .innerJoin(
      agentVersionRepositories,
      eq(
        agentVersionRepositories.agentConfigVersionId,
        agentConfigVersions.id,
      ),
    )
    .innerJoin(
      repositories,
      eq(repositories.id, agentVersionRepositories.repositoryId),
    )
    .innerJoin(
      integrationAccounts,
      and(
        eq(integrationAccounts.id, repositories.integrationAccountId),
        eq(integrationAccounts.organizationId, agents.organizationId),
      ),
    )
    .where(
      and(
        eq(agentConfigVersions.id, versionId),
        eq(integrationAccounts.provider, "github"),
        eq(integrationAccounts.status, "connected"),
        eq(repositories.available, true),
      ),
    );

  return rows.map((repository) => {
    const installationId = Number(repository.installationId);
    if (!Number.isSafeInteger(installationId) || installationId <= 0) {
      throw new Error(
        `GitHub repository ${repository.fullName} has an invalid installation`,
      );
    }
    return {
      defaultBranch: repository.defaultBranch,
      fullName: repository.fullName,
      installationId,
      private: repository.private,
    };
  });
}

export type RuntimeDatadogConnection = {
  authType: "api_keys";
  apiKey: string;
  applicationKey: string;
  datacenter: DatadogDatacenter;
  mcpUrl: string;
  site: DatadogSiteId;
} | {
  authType: "oauth";
  accessToken: string;
  datacenter: DatadogDatacenter;
  mcpUrl: string;
  site: DatadogSiteId;
};

export interface RuntimeSentryConnection {
  accessToken: string;
  mcpUrl: string;
  organizationSlug: string;
  projectSlug?: string;
}

export interface RuntimeCustomMcpConnection {
  accessToken: string;
  accountId: string;
  displayName: string;
  mcpUrl: string;
}

export interface RuntimeVercelConnection {
  accessToken: string;
  accountId: string;
  displayName: string;
  projectIds: string[];
  teamId: string | null;
}

const vercelCredentialsSchema = z.object({
  accessToken: z.string().min(1),
  configurationId: z.string().min(1),
  teamId: z.string().min(1).nullable(),
  userId: z.string().min(1).nullable(),
});

export async function getRuntimeVercelConnections(
  versionId: string,
): Promise<RuntimeVercelConnection[]> {
  const configRows = await getDatabase()
    .select({
      contextAccountIds: agentConfigVersions.contextAccountIds,
      contextResourceIds: agentConfigVersions.contextResourceIds,
      organizationId: agents.organizationId,
    })
    .from(agentConfigVersions)
    .innerJoin(agents, eq(agents.id, agentConfigVersions.agentId))
    .where(eq(agentConfigVersions.id, versionId))
    .limit(1);
  const config = configRows[0];
  if (!config?.contextAccountIds.length || !config.contextResourceIds.length) {
    return [];
  }

  const accountRows = await getDatabase()
    .select({
      id: integrationAccounts.id,
      displayName: integrationAccounts.displayName,
      encryptedCredentials: integrationAccounts.encryptedCredentials,
    })
    .from(integrationAccounts)
    .where(
      and(
        eq(integrationAccounts.organizationId, config.organizationId),
        eq(integrationAccounts.provider, "vercel"),
        eq(integrationAccounts.status, "connected"),
        inArray(integrationAccounts.id, config.contextAccountIds),
      ),
    );
  if (accountRows.length === 0) return [];

  const accountIds = accountRows.map(({ id }) => id);
  const resourceRows = await getDatabase()
    .select({
      id: integrationResources.id,
      integrationAccountId: integrationResources.integrationAccountId,
      externalId: integrationResources.externalId,
    })
    .from(integrationResources)
    .where(
      and(
        inArray(integrationResources.integrationAccountId, accountIds),
        inArray(integrationResources.id, config.contextResourceIds),
        eq(integrationResources.kind, "vercel_project"),
        eq(integrationResources.available, true),
      ),
    );
  const projectIdsByAccount = new Map<string, string[]>();
  for (const resource of resourceRows) {
    const projectIds = projectIdsByAccount.get(resource.integrationAccountId) ?? [];
    projectIds.push(resource.externalId);
    projectIdsByAccount.set(resource.integrationAccountId, projectIds);
  }
  const accountsById = new Map(accountRows.map((account) => [account.id, account]));

  return config.contextAccountIds.flatMap((accountId) => {
    const account = accountsById.get(accountId);
    if (!account?.encryptedCredentials) return [];
    const projectIds = projectIdsByAccount.get(account.id) ?? [];
    if (projectIds.length === 0) return [];
    const credentials = vercelCredentialsSchema.parse(
      decryptCredentials<Record<string, unknown>>(account.encryptedCredentials),
    );
    return [{
      accessToken: credentials.accessToken,
      accountId: account.id,
      displayName: account.displayName,
      projectIds,
      teamId: credentials.teamId,
    }];
  });
}

export function customMcpTokenRefreshFailureEvent(account: {
  displayName: string;
  errorType: string;
  id: string;
  investigationVersionId: string;
}, timestamp = Date.now()) {
  return {
    _aws: {
      Timestamp: timestamp,
      CloudWatchMetrics: [
        {
          Dimensions: [["errorType"]],
          Metrics: [
            { Name: "custom_mcp.token_refresh_failed", Unit: "Count" },
          ],
          Namespace: "Responder",
        },
      ],
    },
    accountId: account.id,
    "custom_mcp.token_refresh_failed": 1,
    displayName: account.displayName,
    errorType: account.errorType,
    event: "custom_mcp_token_refresh_failed",
    investigationVersionId: account.investigationVersionId,
  };
}

export function customMcpCredentialUpdateFailureEvent(input: {
  accountId: string;
  investigationVersionId: string;
}, timestamp = Date.now()) {
  return {
    _aws: {
      Timestamp: timestamp,
      CloudWatchMetrics: [
        {
          Dimensions: [],
          Metrics: [
            { Name: "custom_mcp.credential_update_failed", Unit: "Count" },
          ],
          Namespace: "Responder",
        },
      ],
    },
    accountId: input.accountId,
    "custom_mcp.credential_update_failed": 1,
    event: "custom_mcp_credential_update_failed",
    investigationVersionId: input.investigationVersionId,
    note:
      "investigation continues with non-persisted token; account may need reconnection",
  };
}

export function customMcpTokenRefreshSuccessEvent(input: {
  accountId: string;
  investigationVersionId: string;
}, timestamp = Date.now()) {
  return {
    _aws: {
      Timestamp: timestamp,
      CloudWatchMetrics: [
        {
          Dimensions: [],
          Metrics: [
            { Name: "custom_mcp.token_refresh_succeeded", Unit: "Count" },
          ],
          Namespace: "Responder",
        },
      ],
    },
    accountId: input.accountId,
    "custom_mcp.token_refresh_succeeded": 1,
    event: "custom_mcp_token_refreshed",
    investigationVersionId: input.investigationVersionId,
  };
}

export function customMcpRuntimeAccountSkippedEvent(input: {
  accountId: string;
  investigationVersionId: string;
  reason: "account_missing" | "credentials_missing";
}, timestamp = Date.now()) {
  return {
    _aws: {
      Timestamp: timestamp,
      CloudWatchMetrics: [
        {
          Dimensions: [["reason"]],
          Metrics: [
            { Name: "custom_mcp.runtime_account_skipped", Unit: "Count" },
          ],
          Namespace: "Responder",
        },
      ],
    },
    accountId: input.accountId,
    "custom_mcp.runtime_account_skipped": 1,
    event: "custom_mcp_runtime_account_skipped",
    investigationVersionId: input.investigationVersionId,
    reason: input.reason,
  };
}

export function customMcpTokenReuseEvent(input: {
  accountId: string;
  investigationVersionId: string;
}) {
  return {
    accountId: input.accountId,
    event: "custom_mcp_token_reused",
    investigationVersionId: input.investigationVersionId,
  };
}

export function customMcpReconnectError(
  account: { displayName: string; id: string },
  cause?: unknown,
) {
  return Object.assign(
    new Error(`Reconnect custom MCP ${account.displayName}`, { cause }),
    { accountId: account.id },
  );
}

export function customMcpConnectionsLoadedEvent(input: {
  accountIds: string[];
  investigationVersionId: string;
}) {
  return {
    accountIds: input.accountIds,
    count: input.accountIds.length,
    event: "custom_mcp_connections_loaded",
    investigationVersionId: input.investigationVersionId,
  };
}

function mcpOAuthRedirectUrl(provider: "custom_mcp" | "linear"): string {
  const baseUrl =
    process.env.RESPONDER_PUBLIC_URL ??
    process.env.BETTER_AUTH_URL ??
    "http://localhost:3000";
  return new URL(
    `/api/integrations/${provider}/callback`,
    baseUrl,
  ).toString();
}

async function getRuntimeMcpConnections(
  versionId: string,
  provider: "custom_mcp" | "linear",
  selectedAccountId?: string,
): Promise<RuntimeCustomMcpConnection[]> {
  const configRows = await getDatabase()
    .select({
      contextAccountIds: agentConfigVersions.contextAccountIds,
      organizationId: agents.organizationId,
    })
    .from(agentConfigVersions)
    .innerJoin(agents, eq(agents.id, agentConfigVersions.agentId))
    .where(eq(agentConfigVersions.id, versionId))
    .limit(1);
  const config = configRows[0];
  if (!config?.contextAccountIds.length) return [];

  const accountRows = await getDatabase()
    .select({
      id: integrationAccounts.id,
      displayName: integrationAccounts.displayName,
      encryptedCredentials: integrationAccounts.encryptedCredentials,
    })
    .from(integrationAccounts)
    .where(
      and(
        eq(integrationAccounts.organizationId, config.organizationId),
        eq(integrationAccounts.provider, provider),
        eq(integrationAccounts.status, "connected"),
        inArray(integrationAccounts.id, config.contextAccountIds),
      ),
    );
  const accountsById = new Map(accountRows.map((account) => [account.id, account]));
  const connections: RuntimeCustomMcpConnection[] = [];

  const providerAccountIds = selectedAccountId
    ? [selectedAccountId]
    : accountRows.map((account) => account.id);
  for (const accountId of providerAccountIds) {
    const account = accountsById.get(accountId);
    if (!account?.encryptedCredentials) {
      console.error(
        JSON.stringify(
          customMcpRuntimeAccountSkippedEvent({
            accountId,
            investigationVersionId: versionId,
            reason: account ? "credentials_missing" : "account_missing",
          }),
        ),
      );
      continue;
    }
    const decryptedCredentials = decryptCredentials<Record<string, unknown>>(
      account.encryptedCredentials,
    );

    if (provider === "linear") {
      let credentials: LinearOAuthCredentials;
      try {
        credentials = parseLinearOAuthCredentials(decryptedCredentials);
      } catch (error) {
        console.error(
          JSON.stringify(
            customMcpTokenRefreshFailureEvent({
              ...account,
              errorType: "LegacyLinearCredentials",
              investigationVersionId: versionId,
            }),
          ),
        );
        throw customMcpReconnectError(account, error);
      }

      if (linearAccessTokenNeedsRefresh(credentials)) {
        try {
          credentials = await refreshLinearOAuthCredentials({ credentials });
        } catch (error) {
          console.error(
            JSON.stringify(
              customMcpTokenRefreshFailureEvent({
                ...account,
                errorType: error instanceof Error ? error.name : "UnknownError",
                investigationVersionId: versionId,
              }),
            ),
          );
          throw customMcpReconnectError(account, error);
        }
        const updated = await getDatabase()
          .update(integrationAccounts)
          .set({
            encryptedCredentials: encryptCredentials(credentials),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(integrationAccounts.id, account.id),
              eq(integrationAccounts.organizationId, config.organizationId),
              eq(integrationAccounts.provider, "linear"),
            ),
          )
          .returning({ id: integrationAccounts.id });
        if (updated.length === 0) {
          console.error(
            JSON.stringify(
              customMcpCredentialUpdateFailureEvent({
                accountId: account.id,
                investigationVersionId: versionId,
              }),
            ),
          );
        }
      }
      connections.push({
        accessToken: credentials.accessToken,
        accountId: account.id,
        displayName: account.displayName,
        mcpUrl: LINEAR_READONLY_MCP_URL,
      });
      continue;
    }

    const credentials = parseCustomMcpCredentials(decryptedCredentials);

    if (credentials.authType === "api_token") {
      connections.push({
        accessToken: credentials.apiToken,
        accountId: account.id,
        displayName: account.displayName,
        mcpUrl: credentials.mcpUrl,
      });
      continue;
    }

    let oauth: Awaited<ReturnType<typeof refreshCustomMcpOAuth>>;
    try {
      oauth = await refreshCustomMcpOAuth({
        mcpUrl: credentials.mcpUrl,
        oauth: credentials.oauth,
        redirectUrl: mcpOAuthRedirectUrl("custom_mcp"),
      });
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      const errorType =
        error instanceof Error
          ? typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code)
            ? `${error.name} (${code})`
            : error.name
          : "UnknownError";
      console.error(
        JSON.stringify(
          customMcpTokenRefreshFailureEvent({
            ...account,
            errorType,
            investigationVersionId: versionId,
          }),
        ),
      );
      throw customMcpReconnectError(account, error);
    }
    const accessToken = oauth.tokens?.access_token;
    if (!accessToken) {
      console.error(
        JSON.stringify(
          customMcpTokenRefreshFailureEvent({
            ...account,
            errorType: "MissingAccessToken",
            investigationVersionId: versionId,
          }),
        ),
      );
      throw customMcpReconnectError(account);
    }
    if (oauth === credentials.oauth) {
      console.info(
        JSON.stringify(
          customMcpTokenReuseEvent({
            accountId: account.id,
            investigationVersionId: versionId,
          }),
        ),
      );
    } else {
      const updated = await getDatabase()
        .update(integrationAccounts)
        .set({
          encryptedCredentials: encryptCredentials({
            authType: "oauth",
            mcpUrl: credentials.mcpUrl,
            oauth,
          }),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(integrationAccounts.id, account.id),
            eq(integrationAccounts.organizationId, config.organizationId),
            eq(integrationAccounts.provider, provider),
          ),
        )
        .returning({ id: integrationAccounts.id });
      if (updated.length === 0) {
        console.error(
          JSON.stringify(
            customMcpCredentialUpdateFailureEvent({
              accountId: account.id,
              investigationVersionId: versionId,
            }),
          ),
        );
      } else {
        console.info(
          JSON.stringify(
            customMcpTokenRefreshSuccessEvent({
              accountId: account.id,
              investigationVersionId: versionId,
            }),
          ),
        );
      }
    }
    connections.push({
      accessToken,
      accountId: account.id,
      displayName: account.displayName,
      mcpUrl: credentials.mcpUrl,
    });
  }

  if (connections.length > 0) {
    console.info(
      JSON.stringify(
        customMcpConnectionsLoadedEvent({
          accountIds: connections.map((connection) => connection.accountId),
          investigationVersionId: versionId,
        }),
      ),
    );
  }
  return connections;
}

export function getRuntimeCustomMcpConnections(
  versionId: string,
): Promise<RuntimeCustomMcpConnection[]> {
  return getRuntimeMcpConnections(versionId, "custom_mcp");
}

export async function getRuntimeLinearConnection(
  versionId: string,
  accountId?: string,
): Promise<RuntimeCustomMcpConnection | null> {
  return (await getRuntimeMcpConnections(versionId, "linear", accountId))[0] ?? null;
}
export type RuntimeClickStackConnection = {
  authType: "access_key";
  accessKey: string;
  mcpUrl: string;
} | {
  authType: "oauth";
  accessToken: string;
  mcpUrl: string;
  serviceId: string;
};

const sentryCredentialsSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.string().nullable().optional(),
  installationId: z.uuid(),
});

const sentryAuthorizationSchema = z.object({
  token: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.string().nullable().optional(),
});

const sentryTriggerConfigSchema = z.object({
  integrationAccountId: z.uuid(),
  projectIds: z.array(z.string().min(1)),
});

export async function getRuntimeSentryConnection(
  versionId: string,
  investigationInput?: InvestigationInput,
): Promise<RuntimeSentryConnection | null> {
  const configRows = await getDatabase()
    .select({
      contextAccountIds: agentConfigVersions.contextAccountIds,
      organizationId: agents.organizationId,
      trigger: agentConfigVersions.trigger,
      triggerConfig: agentConfigVersions.triggerConfig,
    })
    .from(agentConfigVersions)
    .innerJoin(agents, eq(agents.id, agentConfigVersions.agentId))
    .where(eq(agentConfigVersions.id, versionId))
    .limit(1);
  const config = configRows[0];
  if (!config) return null;

  const sentryTrigger =
    config.trigger === "sentry_issue"
      ? sentryTriggerConfigSchema.safeParse(config.triggerConfig)
      : null;
  const triggerAccountId = sentryTrigger?.success
    ? sentryTrigger.data.integrationAccountId
    : null;
  const candidateAccountIds = triggerAccountId
    ? [triggerAccountId]
    : config.contextAccountIds;
  if (candidateAccountIds.length === 0) return null;

  const accountRows = await getDatabase()
    .select({
      id: integrationAccounts.id,
      encryptedCredentials: integrationAccounts.encryptedCredentials,
      metadata: integrationAccounts.metadata,
    })
    .from(integrationAccounts)
    .where(
      and(
        eq(integrationAccounts.organizationId, config.organizationId),
        eq(integrationAccounts.provider, "sentry"),
        eq(integrationAccounts.status, "connected"),
        inArray(integrationAccounts.id, candidateAccountIds),
      ),
    )
    .limit(1);
  const account = accountRows[0];
  if (!account?.encryptedCredentials) return null;

  const organizationSlug = z
    .string()
    .min(1)
    .parse(account.metadata.organizationSlug);
  let credentials = sentryCredentialsSchema.parse(
    decryptCredentials<Record<string, unknown>>(account.encryptedCredentials),
  );
  const expiresAt = credentials.expiresAt
    ? Date.parse(credentials.expiresAt)
    : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() + 60_000) {
    const clientId = process.env.SENTRY_CLIENT_ID;
    const clientSecret = process.env.SENTRY_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error("Sentry App credentials are not configured");
    }
    const response = await fetch(
      `https://sentry.io/api/0/sentry-app-installations/${encodeURIComponent(credentials.installationId)}/authorizations/`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: credentials.refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
        }),
      },
    );
    if (!response.ok) {
      console.error(
        JSON.stringify({
          event: "sentry_token_refresh_failed",
          httpStatus: response.status,
          integrationAccountId: account.id,
        }),
      );
      throw new Error("Unable to refresh Sentry access");
    }
    const refreshed = sentryAuthorizationSchema.parse(await response.json());
    credentials = {
      accessToken: refreshed.token,
      refreshToken: refreshed.refreshToken,
      expiresAt: refreshed.expiresAt ?? null,
      installationId: credentials.installationId,
    };
    await getDatabase()
      .update(integrationAccounts)
      .set({
        encryptedCredentials: encryptCredentials(credentials),
        updatedAt: new Date(),
      })
      .where(eq(integrationAccounts.id, account.id));
  }

  let projectSlug: string | undefined;
  const projectId = investigationInput?.attributes?.projectId;
  if (investigationInput?.provider === "sentry") {
    if (
      typeof projectId !== "string" ||
      (sentryTrigger?.success &&
        !sentryTrigger.data.projectIds.includes(projectId))
    ) {
      return null;
    }
    const resourceRows = await getDatabase()
      .select({ metadata: integrationResources.metadata })
      .from(integrationResources)
      .where(
        and(
          eq(integrationResources.integrationAccountId, account.id),
          eq(integrationResources.kind, "sentry_project"),
          eq(integrationResources.externalId, projectId),
          eq(integrationResources.available, true),
        ),
      )
      .limit(1);
    const parsedSlug = z
      .string()
      .min(1)
      .safeParse(resourceRows[0]?.metadata.slug);
    if (!parsedSlug.success) {
      console.error(
        JSON.stringify({
          event: "sentry_project_slug_missing",
          integrationAccountId: account.id,
          projectId,
          versionId,
        }),
      );
      return null;
    }
    projectSlug = parsedSlug.data;
  }

  const path = projectSlug
    ? `/mcp/${encodeURIComponent(organizationSlug)}/${encodeURIComponent(projectSlug)}`
    : `/mcp/${encodeURIComponent(organizationSlug)}`;
  const mcpUrl = new URL(path, "https://mcp.sentry.dev");
  mcpUrl.searchParams.set("skills", "inspect");
  return {
    accessToken: credentials.accessToken,
    mcpUrl: mcpUrl.toString(),
    organizationSlug,
    ...(projectSlug ? { projectSlug } : {}),
  };
}

export async function getRuntimeDatadogConnection(
  versionId: string,
): Promise<RuntimeDatadogConnection | null> {
  const configRows = await getDatabase()
    .select({
      contextAccountIds: agentConfigVersions.contextAccountIds,
      organizationId: agents.organizationId,
    })
    .from(agentConfigVersions)
    .innerJoin(agents, eq(agents.id, agentConfigVersions.agentId))
    .where(eq(agentConfigVersions.id, versionId))
    .limit(1);
  const config = configRows[0];
  if (!config?.contextAccountIds.length) return null;

  const accountRows = await getDatabase()
    .select({
      id: integrationAccounts.id,
      encryptedCredentials: integrationAccounts.encryptedCredentials,
    })
    .from(integrationAccounts)
    .where(
      and(
        eq(integrationAccounts.organizationId, config.organizationId),
        eq(integrationAccounts.provider, "datadog"),
        eq(integrationAccounts.status, "connected"),
        inArray(integrationAccounts.id, config.contextAccountIds),
      ),
    )
    .limit(1);
  const encrypted = accountRows[0]?.encryptedCredentials;
  if (!encrypted) return null;

  const decrypted = decryptCredentials<Record<string, unknown>>(encrypted);
  const apiKeyCredentials = z
    .object({
      authType: z.literal("api_keys"),
      apiKey: z.string().min(1),
      applicationKey: z.string().min(1),
      mcpUrl: z.string().url(),
      site: z.string().min(1),
    })
    .safeParse(decrypted);
  if (apiKeyCredentials.success) {
    const site = getDatadogSite(apiKeyCredentials.data.site);
    return {
      authType: "api_keys",
      apiKey: apiKeyCredentials.data.apiKey,
      applicationKey: apiKeyCredentials.data.applicationKey,
      datacenter: site.name,
      mcpUrl: site.mcpUrl,
      site: site.id,
    };
  }

  const credentials = z
    .object({
      accessToken: z.string().min(1),
      refreshToken: z.string().min(1),
      expiresAt: z.number().positive(),
      clientId: z.string().min(1),
      datacenter: z.string().min(1).optional(),
      mcpUrl: z.string().url(),
      oauthResource: z.string().url().optional(),
      tokenType: z.string().min(1),
      scope: z.string(),
      site: z.string().min(1).optional(),
      tokenUrl: z.string().url().optional(),
    })
    .parse(decrypted);
  const site = getDatadogSite(credentials.site);
  const connection = (accessToken: string): RuntimeDatadogConnection => ({
    authType: "oauth",
    accessToken,
    datacenter: site.name,
    mcpUrl: site.mcpUrl,
    site: site.id,
  });
  if (credentials.expiresAt > Date.now() + 60_000) {
    return connection(credentials.accessToken);
  }

  const response = await fetch(
    credentials.tokenUrl ??
      "https://app.datadoghq.com/api/v2/oauth2/token",
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: credentials.clientId,
        grant_type: "refresh_token",
        refresh_token: credentials.refreshToken,
        resource: credentials.oauthResource ?? DATADOG_OAUTH_RESOURCE,
      }),
    },
  );
  if (!response.ok) throw new Error("Unable to refresh Datadog access");
  const refreshed = z
    .object({
      access_token: z.string().min(1),
      refresh_token: z.string().min(1).optional(),
      token_type: z.string().min(1),
      expires_in: z.number().positive(),
      scope: z.string().optional(),
    })
    .parse(await response.json());
  const nextCredentials = {
    ...credentials,
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token ?? credentials.refreshToken,
    tokenType: refreshed.token_type,
    expiresAt: Date.now() + refreshed.expires_in * 1_000,
    scope: refreshed.scope ?? credentials.scope,
    datacenter: site.name,
    mcpUrl: site.mcpUrl,
    oauthResource: credentials.oauthResource ?? DATADOG_OAUTH_RESOURCE,
    site: site.id,
  };
  await getDatabase()
    .update(integrationAccounts)
    .set({
      encryptedCredentials: encryptCredentials(nextCredentials),
      updatedAt: new Date(),
    })
    .where(eq(integrationAccounts.id, accountRows[0]!.id));
  return connection(nextCredentials.accessToken);
}

export async function getRuntimeSlackConnection(
  versionId: string,
): Promise<RuntimeSlackConnection | null> {
  const configRows = await getDatabase()
    .select({
      contextResourceIds: agentConfigVersions.contextResourceIds,
      organizationId: agents.organizationId,
    })
    .from(agentConfigVersions)
    .innerJoin(agents, eq(agents.id, agentConfigVersions.agentId))
    .where(eq(agentConfigVersions.id, versionId))
    .limit(1);
  const config = configRows[0];
  if (!config?.contextResourceIds.length) return null;

  const resourceRows = await getDatabase()
    .select({
      id: integrationResources.id,
      accountId: integrationAccounts.id,
      accountStatus: integrationAccounts.status,
      available: integrationResources.available,
      displayName: integrationResources.displayName,
      encryptedCredentials: integrationAccounts.encryptedCredentials,
      externalId: integrationResources.externalId,
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
        eq(integrationAccounts.organizationId, config.organizationId),
        inArray(integrationResources.id, config.contextResourceIds),
      ),
    );
  if (resourceRows.length !== config.contextResourceIds.length) return null;

  const slackResourceRows = resourceRows.filter(
    (resource) =>
      resource.provider === "slack" && resource.kind === "slack_channel",
  );
  if (
    slackResourceRows.length === 0 ||
    slackResourceRows.some(
      (resource) =>
        resource.accountStatus !== "connected" || !resource.available,
    )
  ) {
    return null;
  }

  const accountIds = new Set(
    slackResourceRows.map((resource) => resource.accountId),
  );
  if (accountIds.size !== 1) {
    throw new Error("Slack context channels must belong to one workspace");
  }
  const firstResource = slackResourceRows[0];
  if (!firstResource?.encryptedCredentials) return null;
  const credentials = z
    .object({ userAccessToken: z.string().min(1) })
    .safeParse(
      decryptCredentials<Record<string, unknown>>(
        firstResource.encryptedCredentials,
      ),
    );
  if (!credentials.success) {
    console.error(
      JSON.stringify({
        event: "slack_context_credentials_invalid",
        versionId,
      }),
    );
    return null;
  }

  const resourcesById = new Map(
    slackResourceRows.map((resource) => [resource.id, resource]),
  );
  const selectedSlackResourceIds = config.contextResourceIds.filter((id) =>
    resourcesById.has(id),
  );
  return {
    accountId: firstResource.accountId,
    channels: selectedSlackResourceIds.map((resourceId) => {
      const resource = resourcesById.get(resourceId)!;
      return { id: resource.externalId, name: resource.displayName };
    }),
    mcpUrl: SLACK_MCP_URL,
    userAccessToken: credentials.data.userAccessToken,
  };
}

export async function getRuntimeClickStackConnection(
  versionId: string,
): Promise<RuntimeClickStackConnection | null> {
  const configRows = await getDatabase()
    .select({
      contextAccountIds: agentConfigVersions.contextAccountIds,
      organizationId: agents.organizationId,
    })
    .from(agentConfigVersions)
    .innerJoin(agents, eq(agents.id, agentConfigVersions.agentId))
    .where(eq(agentConfigVersions.id, versionId))
    .limit(1);
  const config = configRows[0];
  if (!config?.contextAccountIds.length) return null;

  const accountRows = await getDatabase()
    .select({
      id: integrationAccounts.id,
      encryptedCredentials: integrationAccounts.encryptedCredentials,
    })
    .from(integrationAccounts)
    .where(
      and(
        eq(integrationAccounts.organizationId, config.organizationId),
        eq(integrationAccounts.provider, "clickstack"),
        eq(integrationAccounts.status, "connected"),
        inArray(integrationAccounts.id, config.contextAccountIds),
      ),
    )
    .limit(1);
  const encrypted = accountRows[0]?.encryptedCredentials;
  if (!encrypted) return null;

  const credentials = z.discriminatedUnion("authType", [
    z.object({
      authType: z.literal("access_key"),
      accessKey: z.string().min(1),
      mcpUrl: z.string().url(),
    }),
    z.object({
      authType: z.literal("oauth"),
      accessToken: z.string().min(1),
      clientId: z.string().min(1),
      expiresAt: z.number().positive(),
      mcpUrl: z.literal(CLICKSTACK_CLOUD_MCP_URL),
      refreshToken: z.string().min(1).optional(),
      scope: z.string().optional(),
      serviceId: z.uuid(),
      tokenType: z.string().min(1),
    }),
  ]).parse(decryptCredentials<Record<string, unknown>>(encrypted));

  if (credentials.authType === "access_key") {
    return {
      authType: "access_key",
      accessKey: credentials.accessKey,
      mcpUrl: normalizeClickStackMcpUrl(credentials.mcpUrl),
    };
  }

  const connection = (accessToken: string): RuntimeClickStackConnection => ({
    authType: "oauth",
    accessToken,
    mcpUrl: CLICKSTACK_CLOUD_MCP_URL,
    serviceId: credentials.serviceId,
  });
  if (credentials.expiresAt > Date.now() + 60_000) {
    return connection(credentials.accessToken);
  }
  if (!credentials.refreshToken) {
    throw new Error("Reconnect ClickStack Cloud to renew access");
  }

  const response = await fetch(`${CLICKSTACK_CLOUD_OAUTH_ISSUER}/token`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: credentials.clientId,
      grant_type: "refresh_token",
      refresh_token: credentials.refreshToken,
      resource: CLICKSTACK_CLOUD_OAUTH_RESOURCE,
    }),
  });
  if (!response.ok) {
    logClickStackTokenRefreshFailure(response.status);
    throw new Error("Unable to refresh ClickStack Cloud access");
  }
  const refreshed = z.object({
    access_token: z.string().min(1),
    expires_in: z.number().positive(),
    refresh_token: z.string().min(1).optional(),
    scope: z.string().optional(),
    token_type: z.string().min(1).default("Bearer"),
  }).parse(await response.json());
  const nextCredentials = {
    ...credentials,
    accessToken: refreshed.access_token,
    expiresAt: Date.now() + refreshed.expires_in * 1_000,
    refreshToken: refreshed.refresh_token ?? credentials.refreshToken,
    scope: refreshed.scope ?? credentials.scope,
    tokenType: refreshed.token_type,
  };
  await getDatabase()
    .update(integrationAccounts)
    .set({
      encryptedCredentials: encryptCredentials(nextCredentials),
      updatedAt: new Date(),
    })
    .where(eq(integrationAccounts.id, accountRows[0]!.id));
  return connection(nextCredentials.accessToken);
}

export async function beginInvestigation(
  agentId: string,
  input: InvestigationInput,
): Promise<BeginInvestigationResult> {
  const db = getDatabase();
  const payloadHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");

  return db.transaction(async (tx) => {
    const agentRows = await tx
      .select({
        id: agents.id,
        organizationId: agents.organizationId,
        activeVersionId: agents.activeVersionId,
      })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.enabled, true)))
      .limit(1);
    const agent = agentRows[0];

    if (!agent?.activeVersionId) {
      throw new Error("Agent is missing an active configuration");
    }

    const configRows = await tx
      .select({
        id: agentConfigVersions.id,
        agentId: agentConfigVersions.agentId,
        model: agentConfigVersions.model,
        prompt: agentConfigVersions.prompt,
        prMode: agentConfigVersions.prMode,
        createLinearTickets: agentConfigVersions.createLinearTickets,
        linearIssueTemplate: agentConfigVersions.linearIssueTemplate,
      })
      .from(agentConfigVersions)
      .where(eq(agentConfigVersions.id, agent.activeVersionId))
      .limit(1);
    const config = configRows[0];

    if (!config || config.agentId !== agent.id) {
      throw new Error("Agent configuration is invalid");
    }

    const activeProfiles = await tx
      .select({ id: runtimeProfiles.id })
      .from(instanceConfiguration)
      .innerJoin(
        runtimeProfiles,
        eq(runtimeProfiles.id, instanceConfiguration.activeRuntimeProfileId),
      )
      .where(eq(instanceConfiguration.id, "default"))
      .limit(1);
    const activeProfile = activeProfiles[0];
    if (!activeProfile) throw new InstanceRuntimeProfileError();

    const investigationId = randomUUID();
    const insertedReceipt = await tx
      .insert(webhookReceipts)
      .values({
        organizationId: agent.organizationId,
        provider: input.provider,
        externalEventId: input.externalEventId,
        investigationId,
        payloadHash,
      })
      .onConflictDoNothing({
        target: [webhookReceipts.provider, webhookReceipts.externalEventId],
      })
      .returning({ investigationId: webhookReceipts.investigationId });

    if (!insertedReceipt[0]) {
      const existing = await tx
        .select({ investigationId: webhookReceipts.investigationId })
        .from(webhookReceipts)
        .where(
          and(
            eq(webhookReceipts.provider, input.provider),
            eq(webhookReceipts.externalEventId, input.externalEventId),
          ),
        )
        .limit(1);

      if (!existing[0]) {
        throw new Error("Unable to resolve duplicate webhook receipt");
      }

      return {
        created: false,
        investigationId: existing[0].investigationId,
        runtimeProfileId: activeProfile.id,
        config: {
          ...config,
          organizationId: agent.organizationId,
        },
      };
    }

    await tx.insert(investigations).values({
      id: investigationId,
      organizationId: agent.organizationId,
      agentId: agent.id,
      agentConfigVersionId: config.id,
      runtimeProfileId: activeProfile.id,
      title: input.title,
      input,
    });

    return {
      created: true,
      investigationId,
      runtimeProfileId: activeProfile.id,
      config: {
        ...config,
        organizationId: agent.organizationId,
      },
    };
  });
}

export async function markInvestigationStarted(
  investigationId: string,
  eveSessionId: string,
): Promise<void> {
  await getDatabase()
    .update(investigations)
    .set({
      completedAt: null,
      failureReason: null,
      status: "investigating",
      eveSessionId,
      startedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(investigations.id, investigationId));
}

export async function discardPendingInvestigation(
  investigationId: string,
): Promise<void> {
  await getDatabase().transaction(async (tx) => {
    const deleted = await tx
      .delete(investigations)
      .where(
        and(
          eq(investigations.id, investigationId),
          eq(investigations.status, "pending"),
        ),
      )
      .returning({ id: investigations.id });

    if (deleted[0]) {
      await tx
        .delete(webhookReceipts)
        .where(eq(webhookReceipts.investigationId, investigationId));
    }
  });
}

export async function completeInvestigation(
  investigationId: string,
  reportMarkdown: string,
): Promise<void> {
  const existing = await getDatabase()
    .select({ structuredReport: investigations.structuredReport })
    .from(investigations)
    .where(eq(investigations.id, investigationId))
    .limit(1);
  if (existing[0]?.structuredReport) return;

  await getDatabase()
    .update(investigations)
    .set({
      status: "resolved",
      reportMarkdown,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(investigations.id, investigationId));
}

export function replayReportMarkdownUpdate(
  existingReportMarkdown: string | null,
  reportMarkdown: string,
): { reportMarkdown?: string } {
  return existingReportMarkdown === null ? { reportMarkdown } : {};
}

export async function completeInvestigationReplay(
  investigationId: string,
  reportMarkdown: string,
): Promise<void> {
  await getDatabase().transaction(async (tx) => {
    const existing = await tx
      .select({ reportMarkdown: investigations.reportMarkdown })
      .from(investigations)
      .where(eq(investigations.id, investigationId))
      .limit(1);

    await tx
      .update(investigations)
      .set({
        status: "resolved",
        ...replayReportMarkdownUpdate(
          existing[0]?.reportMarkdown ?? null,
          reportMarkdown,
        ),
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(investigations.id, investigationId));
    await tx
      .update(investigationReplayRequests)
      .set({
        completedAt: new Date(),
        failureReason: null,
        status: "completed",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(
            investigationReplayRequests.replayInvestigationId,
            investigationId,
          ),
          inArray(investigationReplayRequests.status, [
            "pending",
            "processing",
            "queued",
            "failed",
          ]),
        ),
      );
  });
}

export async function failInvestigation(
  investigationId: string,
  reason: string,
): Promise<boolean> {
  const rows = await getDatabase()
    .update(investigations)
    .set({
      status: "failed",
      failureReason: reason,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(investigations.id, investigationId),
        inArray(investigations.status, ["pending", "investigating"]),
      ),
    )
    .returning({ id: investigations.id });
  return rows.length > 0;
}
