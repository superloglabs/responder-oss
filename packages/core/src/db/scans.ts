import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { AgentConfiguration } from "../agents/config.js";
import { defaultLinearIssueTemplate } from "../agents/config.js";
import type { InvestigationRequest } from "../investigations/input.js";
import { scanInstructions, type ScanConfiguration } from "../scans/config.js";
import { createAgent, updateAgent } from "./agents.js";
import { getDatabase } from "./client.js";
import { getInvestigationIssueDetails } from "./issues.js";
import {
  agents,
  integrationAccounts,
  integrationResources,
  investigationIssues,
  investigations,
  scanConfigurations,
} from "./schema.js";

export class ScanConfigurationError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "channel_not_found"
      | "configuration_incomplete"
      | "scan_already_running",
  ) {
    super(message);
  }
}

type Channel = {
  displayName: string;
  externalId: string;
  integrationAccountId: string;
};

async function resolveSlackChannel(
  organizationId: string,
  resourceId: string,
): Promise<Channel> {
  const rows = await getDatabase()
    .select({
      displayName: integrationResources.displayName,
      externalId: integrationResources.externalId,
      integrationAccountId: integrationAccounts.id,
    })
    .from(integrationResources)
    .innerJoin(
      integrationAccounts,
      eq(integrationAccounts.id, integrationResources.integrationAccountId),
    )
    .where(
      and(
        eq(integrationResources.id, resourceId),
        eq(integrationResources.kind, "slack_channel"),
        eq(integrationResources.available, true),
        eq(integrationAccounts.organizationId, organizationId),
        eq(integrationAccounts.provider, "slack"),
        eq(integrationAccounts.status, "connected"),
      ),
    )
    .limit(1);
  const channel = rows[0];
  if (!channel) {
    throw new ScanConfigurationError(
      "Choose an available Slack channel",
      "channel_not_found",
    );
  }
  return channel;
}

export async function scanAgentConfiguration(input: {
  organizationId: string;
  configuration: ScanConfiguration;
}): Promise<AgentConfiguration | null> {
  if (!input.configuration.slackChannelResourceId) return null;
  const channel = await resolveSlackChannel(
    input.organizationId,
    input.configuration.slackChannelResourceId,
  );
  return {
    name: "Responder scans",
    description: "Periodic proactive investigation of connected production context",
    model: "instance/default",
    instructions: scanInstructions,
    enabled: true,
    prMode: "disabled",
    repositoryIds: input.configuration.repositoryIds,
    contextAccountIds: input.configuration.contextAccountIds,
    contextResourceIds: input.configuration.contextResourceIds,
    secretIds: [],
    createLinearTickets: false,
    linearIssueTemplate: defaultLinearIssueTemplate,
    trigger: {
      kind: "slack_channel",
      integrationAccountId: channel.integrationAccountId,
      channelId: channel.externalId,
    },
    reporting: {
      mode: "output_channel",
      integrationAccountId: channel.integrationAccountId,
      outputChannelId: channel.externalId,
    },
  };
}

export async function getScanConfiguration(organizationId: string) {
  const rows = await getDatabase()
    .select({
      agentId: scanConfigurations.agentId,
      frequencyHours: scanConfigurations.frequencyHours,
      slackChannelResourceId: scanConfigurations.slackChannelResourceId,
      contextAccountIds: scanConfigurations.contextAccountIds,
      contextResourceIds: scanConfigurations.contextResourceIds,
      repositoryIds: scanConfigurations.repositoryIds,
      nextRunAt: scanConfigurations.nextRunAt,
      channelName: integrationResources.displayName,
    })
    .from(scanConfigurations)
    .leftJoin(
      integrationResources,
      eq(integrationResources.id, scanConfigurations.slackChannelResourceId),
    )
    .where(eq(scanConfigurations.organizationId, organizationId))
    .limit(1);
  const row = rows[0];
  return row
    ? {
        ...row,
        frequencyHours:
          row.frequencyHours === 1 || row.frequencyHours === 6
            ? row.frequencyHours
            : null,
      }
    : {
        agentId: null,
        frequencyHours: null,
        slackChannelResourceId: null,
        contextAccountIds: [],
        contextResourceIds: [],
        repositoryIds: [],
        nextRunAt: null,
        channelName: null,
      };
}

export async function saveScanConfiguration(input: {
  organizationId: string;
  userId: string;
  configuration: ScanConfiguration;
}) {
  const agentConfiguration = await scanAgentConfiguration(input);
  const existing = await getScanConfiguration(input.organizationId);
  let agentId = existing.agentId;
  if (agentConfiguration) {
    if (agentId) {
      await updateAgent({
        agentId,
        organizationId: input.organizationId,
        userId: input.userId,
        configuration: agentConfiguration,
        purpose: "scan",
      });
    } else {
      agentId = await createAgent({
        organizationId: input.organizationId,
        userId: input.userId,
        configuration: agentConfiguration,
        purpose: "scan",
      });
    }
  }

  const frequencyChanged =
    existing.frequencyHours !== input.configuration.frequencyHours;
  const nextRunAt = input.configuration.frequencyHours === null
    ? null
    : frequencyChanged || !existing.nextRunAt
      ? new Date(Date.now() + input.configuration.frequencyHours * 60 * 60 * 1_000)
      : existing.nextRunAt;

  await getDatabase()
    .insert(scanConfigurations)
    .values({
      organizationId: input.organizationId,
      agentId,
      ...input.configuration,
      nextRunAt,
      updatedBy: input.userId,
    })
    .onConflictDoUpdate({
      target: scanConfigurations.organizationId,
      set: {
        agentId,
        ...input.configuration,
        nextRunAt,
        updatedBy: input.userId,
        updatedAt: new Date(),
      },
    });
  return getScanConfiguration(input.organizationId);
}

function numberAttribute(
  attributes: Record<string, string | number | boolean | null> | undefined,
  name: string,
): number {
  const value = attributes?.[name];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringAttribute(
  attributes: Record<string, string | number | boolean | null> | undefined,
  name: string,
): string | null {
  const value = attributes?.[name];
  return typeof value === "string" ? value : null;
}

export async function listScanRuns(organizationId: string, limit = 50) {
  const rows = await getDatabase()
    .select({
      id: investigations.id,
      status: investigations.status,
      input: investigations.input,
      failureReason: investigations.failureReason,
      createdAt: investigations.createdAt,
      startedAt: investigations.startedAt,
      completedAt: investigations.completedAt,
      activeIssues: count(investigationIssues.issueId),
      filedIssues: sql<number>`count(${investigationIssues.issueId}) filter (where ${investigationIssues.relationship} = 'new')`,
    })
    .from(investigations)
    .innerJoin(agents, eq(agents.id, investigations.agentId))
    .leftJoin(
      investigationIssues,
      eq(investigationIssues.investigationId, investigations.id),
    )
    .where(
      and(
        eq(investigations.organizationId, organizationId),
        eq(agents.purpose, "scan"),
        eq(investigations.isReplay, false),
      ),
    )
    .groupBy(investigations.id)
    .orderBy(desc(investigations.createdAt))
    .limit(limit);
  return rows.map((row) => ({
    ...row,
    activeIssues: Number(row.activeIssues),
    filedIssues: Number(row.filedIssues),
    sourceCount: numberAttribute(row.input.attributes, "sourceCount"),
    slackChannelName: stringAttribute(row.input.attributes, "slackChannelName"),
  }));
}

export async function getScanRun(input: {
  organizationId: string;
  scanId: string;
}) {
  const rows = await getDatabase()
    .select({
      id: investigations.id,
      status: investigations.status,
      input: investigations.input,
      failureReason: investigations.failureReason,
      reportMarkdown: investigations.reportMarkdown,
      createdAt: investigations.createdAt,
      startedAt: investigations.startedAt,
      completedAt: investigations.completedAt,
    })
    .from(investigations)
    .innerJoin(agents, eq(agents.id, investigations.agentId))
    .where(
      and(
        eq(investigations.id, input.scanId),
        eq(investigations.organizationId, input.organizationId),
        eq(agents.purpose, "scan"),
      ),
    )
    .limit(1);
  const run = rows[0];
  if (!run) return null;
  const findings = await getInvestigationIssueDetails(run.id);
  return {
    ...run,
    sourceCount: numberAttribute(run.input.attributes, "sourceCount"),
    slackChannelName: stringAttribute(run.input.attributes, "slackChannelName"),
    findings,
  };
}

export async function hasActiveScanRun(organizationId: string): Promise<boolean> {
  const rows = await getDatabase()
    .select({ id: investigations.id })
    .from(investigations)
    .innerJoin(agents, eq(agents.id, investigations.agentId))
    .where(
      and(
        eq(investigations.organizationId, organizationId),
        eq(agents.purpose, "scan"),
        inArray(investigations.status, ["pending", "investigating"]),
      ),
    )
    .limit(1);
  return Boolean(rows[0]);
}

export async function createScanInvestigationRequest(input: {
  organizationId: string;
  externalEventId: string;
  scheduledFor?: Date;
}): Promise<InvestigationRequest> {
  if (await hasActiveScanRun(input.organizationId)) {
    throw new ScanConfigurationError(
      "A scan is already running",
      "scan_already_running",
    );
  }
  const configuration = await getScanConfiguration(input.organizationId);
  const sourceCount =
    configuration.contextAccountIds.length +
    Number(configuration.repositoryIds.length > 0);
  if (!configuration.agentId || !configuration.slackChannelResourceId || sourceCount === 0) {
    throw new ScanConfigurationError(
      "Choose a Slack channel and at least one connected integration",
      "configuration_incomplete",
    );
  }
  const end = input.scheduledFor ?? new Date();
  const lookbackHours = configuration.frequencyHours ?? 1;
  const start = new Date(end.getTime() - lookbackHours * 60 * 60 * 1_000);
  return {
    agentId: configuration.agentId,
    provider: "scan",
    externalEventId: input.externalEventId,
    title: `Production scan · ${end.toISOString()}`,
    body: [
      `Inspect the connected sources for active production issues between ${start.toISOString()} and ${end.toISOString()}.`,
      "Confirm that each finding is still active. Search existing issues before filing a new one, then submit the structured report.",
    ].join("\n\n"),
    attributes: {
      scanWindowStart: start.toISOString(),
      scanWindowEnd: end.toISOString(),
      sourceCount,
      slackChannelName: configuration.channelName ?? "Slack",
    },
  };
}

export async function claimDueScans(now = new Date(), limit = 20) {
  return getDatabase().transaction(async (tx) => {
    const rows = await tx
      .select({
        organizationId: scanConfigurations.organizationId,
        frequencyHours: scanConfigurations.frequencyHours,
        scheduledFor: scanConfigurations.nextRunAt,
      })
      .from(scanConfigurations)
      .where(
        and(
          isNotNull(scanConfigurations.agentId),
          isNotNull(scanConfigurations.frequencyHours),
          isNotNull(scanConfigurations.slackChannelResourceId),
          lte(scanConfigurations.nextRunAt, now),
          or(
            sql`jsonb_array_length(${scanConfigurations.contextAccountIds}) > 0`,
            sql`jsonb_array_length(${scanConfigurations.repositoryIds}) > 0`,
          ),
        ),
      )
      .orderBy(scanConfigurations.nextRunAt)
      .limit(limit)
      .for("update", { skipLocked: true });

    for (const row of rows) {
      if (!row.scheduledFor || !row.frequencyHours) continue;
      await tx
        .update(scanConfigurations)
        .set({
          nextRunAt: new Date(now.getTime() + row.frequencyHours * 60 * 60 * 1_000),
          updatedAt: now,
        })
        .where(eq(scanConfigurations.organizationId, row.organizationId));
    }
    return rows.filter(
      (row): row is typeof row & { frequencyHours: number; scheduledFor: Date } =>
        Boolean(row.frequencyHours && row.scheduledFor),
    );
  });
}
