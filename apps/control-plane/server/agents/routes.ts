import { Hono } from "hono";
import { z } from "zod";
import { captureAnalyticsEvent } from "@responder/core/analytics";
import {
  agentConfigurationSchema,
  slackThreadModeConfigurationSchema,
} from "../../../../packages/core/src/agents/config.js";
import type { AgentConfiguration } from "../../../../packages/core/src/agents/config.js";
import { decryptCredentials } from "../../../../packages/core/src/credentials/encryption.js";
import {
  AgentConfigurationError,
  createAgent,
  disableAgentsWithUnavailableRepositories,
  getAgent,
  getSlackThreadModeConfiguration,
  listAgentOptions,
  listAgents,
  setAgentEnabled,
  saveSlackThreadModeConfiguration,
  updateAgent,
} from "../../../../packages/core/src/db/agents.js";
import {
  getSlackChannelConnection,
  listConnectedIntegrationAccounts,
  listConnectedIntegrationAccountCredentials,
  markSlackChannelJoined,
  replaceRepositories,
  replaceIntegrationResources,
} from "../../../../packages/core/src/db/integrations.js";
import {
  getInvestigationDetail,
  getInvestigationForRetry,
  investigationCanBeRetried,
  listInvestigationTraceEvents,
} from "../../../../packages/core/src/db/investigations.js";
import {
  createWorkspaceSecretRecord,
  findWorkspaceSecretByName,
} from "../../../../packages/core/src/db/workspace-secrets.js";
import { workspaceSecretEnvironmentVariableNameReservation } from "../../../../packages/core/src/workspace-secret-names.js";
import type { InvestigationTraceEvent } from "../../../../packages/core/src/db/schema.js";
import {
  joinSlackChannel,
  listSlackChannels,
  SlackChannelJoinError,
} from "../integrations/slack.js";
import { listGitHubRepositories } from "../integrations/github.js";
import { getActiveTenant } from "../tenant.js";
import { queueInvestigationRetry } from "../investigations/queue.js";
import {
  createDaytonaWorkspaceSecret,
  deleteDaytonaWorkspaceSecret,
} from "./daytona-secrets.js";

const slackCredentialsSchema = z.object({
  accessToken: z.string().min(1),
});

const githubInstallationIdSchema = z.coerce.number().int().positive();

const agentEnabledSchema = z.object({
  enabled: z.boolean(),
});

const secretHostSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(253)
  .regex(
    /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/,
    "Use a hostname without a scheme, path, or port",
  );

export const workspaceSecretInputSchema = z.object({
  name: z
    .string()
    .trim()
    .toUpperCase()
    .min(1, "Environment variable name is required")
    .max(80)
    .regex(
      /^[A-Z_][A-Z0-9_]*$/,
      "Use an uppercase environment variable name",
    )
    .superRefine((name, context) => {
      const reservation = workspaceSecretEnvironmentVariableNameReservation(name);
      if (reservation) {
        context.addIssue({ code: "custom", message: reservation });
      }
    }),
  value: z.string().min(1, "Secret value is required").max(65_536),
  allowedHosts: z
    .array(secretHostSchema)
    .min(1, "Add at least one allowed host")
    .max(20)
    .transform((hosts) => [...new Set(hosts)]),
});

function isWorkspaceSecretNameConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505" &&
    "constraint" in error &&
    error.constraint === "workspace_secrets_organization_name_idx"
  );
}

const tenantHiddenTraceEventTypes = new Set([
  "instructions.configured",
  "message.received",
]);

function tenantVisibleTraceEvents(
  events: InvestigationTraceEvent[],
): InvestigationTraceEvent[] {
  return events.filter((event) => !tenantHiddenTraceEventTypes.has(event.type));
}

export async function refreshSlackChannelResources(
  organizationId: string,
): Promise<void> {
  const accounts = await listConnectedIntegrationAccountCredentials(
    organizationId,
    "slack",
  );

  await Promise.all(
    accounts.map(async (account) => {
      const credentials = slackCredentialsSchema.parse(
        decryptCredentials<Record<string, unknown>>(
          account.encryptedCredentials!,
        ),
      );
      const channels = await listSlackChannels(credentials.accessToken);
      await replaceIntegrationResources(
        account.id,
        "slack_channel",
        channels,
      );
    }),
  );
}

export async function refreshGitHubRepositories(
  organizationId: string,
): Promise<void> {
  const accounts = await listConnectedIntegrationAccounts(
    organizationId,
    "github",
  );

  await Promise.all(
    accounts.map(async (account) => {
      const repositories = await listGitHubRepositories(
        githubInstallationIdSchema.parse(account.externalAccountId),
      );
      await replaceRepositories(account.id, repositories);
    }),
  );
}

async function ensureSlackChannelMemberships(
  organizationId: string,
  configuration: AgentConfiguration,
): Promise<void> {
  const trigger = configuration.trigger;
  const channelTargets: Array<{
    channelId: string;
    integrationAccountId: string;
  }> = [];

  if (trigger.kind === "slack_channel") {
    channelTargets.push({
      channelId: trigger.channelId,
      integrationAccountId: trigger.integrationAccountId,
    });
  } else if (trigger.kind === "slack_mention") {
    channelTargets.push(
      ...trigger.channelIds.map((channelId) => ({
        channelId,
        integrationAccountId: trigger.integrationAccountId,
      })),
    );
  }

  if (configuration.reporting.mode !== "thread") {
    channelTargets.push({
      channelId: configuration.reporting.outputChannelId,
      integrationAccountId: configuration.reporting.integrationAccountId,
    });
  }

  const uniqueTargets = [
    ...new Map(
      channelTargets.map((target) => [
        `${target.integrationAccountId}:${target.channelId}`,
        target,
      ]),
    ).values(),
  ];

  for (const { channelId, integrationAccountId } of uniqueTargets) {
    const connection = await getSlackChannelConnection({
      organizationId,
      integrationAccountId,
      channelId,
    });
    if (!connection || connection.metadata.isMember === true) continue;
    if (connection.metadata.isPrivate === true) {
      throw new SlackChannelJoinError("private_channel_invite_required");
    }
    if (!connection.encryptedCredentials) {
      throw new SlackChannelJoinError("missing_credentials");
    }

    const credentials = slackCredentialsSchema.parse(
      decryptCredentials<Record<string, unknown>>(
        connection.encryptedCredentials,
      ),
    );
    await joinSlackChannel(credentials.accessToken, channelId);
    await markSlackChannelJoined({
      integrationAccountId,
      channelId,
      metadata: connection.metadata,
    });
  }
}

function configurationError(error: unknown): {
  body: { error: string; code?: string };
  status: 400 | 404;
} {
  if (error instanceof AgentConfigurationError) {
    return {
      body: { error: error.message, code: error.code },
      status: error.code === "agent_not_found" ? 404 : 400,
    };
  }
  throw error;
}

export const agentRoutes = new Hono()
  .get("/", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }

    return context.json({
      agents: await listAgents(tenant.organizationId),
    });
  })
  .get("/options", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }

    return context.json(await listAgentOptions(tenant.organizationId));
  })
  .get("/thread-mode", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }
    return context.json({
      configuration: await getSlackThreadModeConfiguration(
        tenant.organizationId,
      ),
    });
  })
  .put("/thread-mode", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }
    const parsed = slackThreadModeConfigurationSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return context.json(
        { error: "Invalid tag mode configuration", issues: parsed.error.issues },
        400,
      );
    }
    try {
      await saveSlackThreadModeConfiguration({
        organizationId: tenant.organizationId,
        userId: tenant.user.id,
        configuration: parsed.data,
      });
      return context.json({ configuration: parsed.data });
    } catch (error) {
      const response = configurationError(error);
      return context.json(response.body, response.status);
    }
  })
  .post("/options/refresh/slack", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }

    try {
      await refreshSlackChannelResources(tenant.organizationId);
      return context.json(await listAgentOptions(tenant.organizationId));
    } catch (error) {
      console.error("Unable to refresh Slack channels", error);
      return context.json(
        {
          error: "Unable to refresh Slack channels",
          code: "slack_refresh_failed",
        },
        502,
      );
    }
  })
  .post("/options/refresh/github", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }

    try {
      await refreshGitHubRepositories(tenant.organizationId);
      await disableAgentsWithUnavailableRepositories(tenant.organizationId);
      return context.json(await listAgentOptions(tenant.organizationId));
    } catch (error) {
      console.error("Unable to refresh GitHub repositories", error);
      return context.json(
        {
          error: "Unable to refresh GitHub repositories",
          code: "github_refresh_failed",
        },
        502,
      );
    }
  })
  .post("/secrets", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }

    const parsed = workspaceSecretInputSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return context.json(
        { error: "Invalid workspace secret", issues: parsed.error.issues },
        400,
      );
    }

    const existing = await findWorkspaceSecretByName({
      organizationId: tenant.organizationId,
      name: parsed.data.name,
    });
    if (existing) {
      return context.json(
        { error: `${parsed.data.name} already exists in this workspace` },
        409,
      );
    }

    let daytonaSecret: { id: string; name: string } | null = null;
    try {
      daytonaSecret = await createDaytonaWorkspaceSecret({
        value: parsed.data.value,
        allowedHosts: parsed.data.allowedHosts,
      });
      const secret = await createWorkspaceSecretRecord({
        organizationId: tenant.organizationId,
        userId: tenant.user.id,
        name: parsed.data.name,
        allowedHosts: parsed.data.allowedHosts,
        daytonaSecretId: daytonaSecret.id,
        daytonaSecretName: daytonaSecret.name,
      });
      return context.json({ secret }, 201);
    } catch (error) {
      if (daytonaSecret) {
        try {
          await deleteDaytonaWorkspaceSecret(daytonaSecret.id);
        } catch (cleanupError) {
          console.error("Unable to clean up workspace secret", {
            cleanupError,
            daytonaSecretId: daytonaSecret.id,
          });
          return context.json(
            { error: "Unable to clean up workspace secret after storage failed" },
            502,
          );
        }
      }
      if (isWorkspaceSecretNameConflict(error)) {
        return context.json(
          { error: `${parsed.data.name} already exists in this workspace` },
          409,
        );
      }
      return context.json({ error: "Unable to store workspace secret" }, 502);
    }
  })
  .post("/", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }

    const parsed = agentConfigurationSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return context.json(
        {
          error: "Invalid agent configuration",
          issues: parsed.error.issues,
        },
        400,
      );
    }
    if (
      parsed.data.trigger.kind !== "slack_channel" ||
      parsed.data.reporting.mode !== "thread"
    ) {
      return context.json(
        {
          error:
            "New agents must use a Slack channel alert and reply in its thread",
        },
        400,
      );
    }

    try {
      await ensureSlackChannelMemberships(
        tenant.organizationId,
        parsed.data,
      );
      const agentId = await createAgent({
        organizationId: tenant.organizationId,
        userId: tenant.user.id,
        configuration: parsed.data,
      });
      await captureAnalyticsEvent({
        distinctId: tenant.user.id,
        event: "agent created",
        organizationId: tenant.organizationId,
        properties: {
          agent_id: agentId,
          enabled: parsed.data.enabled,
          model: parsed.data.model,
          pr_mode: parsed.data.prMode,
          trigger_kind: parsed.data.trigger.kind,
        },
      });
      return context.json({ agentId }, 201);
    } catch (error) {
      if (error instanceof SlackChannelJoinError) {
        return context.json(
          { error: error.message, code: "slack_join_failed" },
          400,
        );
      }
      const response = configurationError(error);
      return context.json(response.body, response.status);
    }
  })
  .get("/:agentId", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }

    const agent = await getAgent(
      tenant.organizationId,
      context.req.param("agentId"),
    );
    if (!agent) return context.json({ error: "Agent not found" }, 404);

    return context.json({ agent });
  })
  .get("/:agentId/investigations/:investigationId", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }

    const investigation = await getInvestigationDetail({
      organizationId: tenant.organizationId,
      agentId: context.req.param("agentId"),
      investigationId: context.req.param("investigationId"),
    });
    if (!investigation) {
      return context.json({ error: "Investigation not found" }, 404);
    }

    let trace: {
      events: unknown[];
      sessionId: string | null;
      truncated: boolean;
    } = {
      events: [],
      sessionId: investigation.eveSessionId,
      truncated: false,
    };
    let traceError: string | null = null;

    if (investigation.eveSessionId?.startsWith("openai-daytona:")) {
      try {
        const storedTrace = await listInvestigationTraceEvents(
          investigation.id,
        );
        trace = {
          events: tenantVisibleTraceEvents(storedTrace.events),
          sessionId: investigation.eveSessionId,
          truncated: storedTrace.truncated,
        };
      } catch (error) {
        traceError =
          error instanceof Error ? error.message : "Unable to load trace";
      }
    }

    return context.json({ investigation, trace, traceError });
  })
  .post("/:agentId/investigations/:investigationId/retry", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }

    const investigation = await getInvestigationForRetry({
      organizationId: tenant.organizationId,
      agentId: context.req.param("agentId"),
      investigationId: context.req.param("investigationId"),
    });
    if (!investigation) {
      return context.json({ error: "Investigation not found" }, 404);
    }
    if (!investigationCanBeRetried(investigation.status)) {
      return context.json(
        { error: "Only finished investigations can be retried" },
        409,
      );
    }

    try {
      const retry = await queueInvestigationRetry({
        investigationId: investigation.id,
        organizationId: tenant.organizationId,
      });
      if (retry.kind === "blocked") {
        return context.json(
          { error: "Monthly investigation allowance exhausted" },
          402,
        );
      }
      return context.json(
        {
          investigationId: retry.investigationId,
          sessionId: `openai-daytona:${retry.jobId}`,
        },
        202,
      );
    } catch (error) {
      return context.json(
        {
          error: error instanceof Error ? error.message : "Unable to rerun investigation",
        },
        502,
      );
    }
  })
  .patch("/:agentId", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }

    const parsed = agentEnabledSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return context.json({ error: "Invalid agent status" }, 400);
    }

    const updated = await setAgentEnabled({
      agentId: context.req.param("agentId"),
      organizationId: tenant.organizationId,
      enabled: parsed.data.enabled,
    });
    if (!updated) return context.json({ error: "Agent not found" }, 404);

    return context.json({
      agentId: context.req.param("agentId"),
      enabled: parsed.data.enabled,
    });
  })
  .put("/:agentId", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }

    const parsed = agentConfigurationSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return context.json(
        {
          error: "Invalid agent configuration",
          issues: parsed.error.issues,
        },
        400,
      );
    }

    try {
      await ensureSlackChannelMemberships(
        tenant.organizationId,
        parsed.data,
      );
      await updateAgent({
        agentId: context.req.param("agentId"),
        organizationId: tenant.organizationId,
        userId: tenant.user.id,
        configuration: parsed.data,
      });
      return context.json({ agentId: context.req.param("agentId") });
    } catch (error) {
      if (error instanceof SlackChannelJoinError) {
        return context.json(
          { error: error.message, code: "slack_join_failed" },
          400,
        );
      }
      const response = configurationError(error);
      return context.json(response.body, response.status);
    }
  });
