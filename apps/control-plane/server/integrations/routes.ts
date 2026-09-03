import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { captureAnalyticsEvent } from "@responder/core/analytics";
import {
  decryptCredentials,
  encryptCredentials,
} from "../../../../packages/core/src/credentials/encryption.js";
import {
  consumeIntegrationConnectionState,
  createIntegrationConnectionState,
  deleteIntegrationAccount,
  getOrganizationIntegrationAccount,
  getOrganizationIntegrationAccountByExternalId,
  getRecoverableSentryIntegrationAccount,
  listConnectedSentryIntegrationAccounts,
  listOrganizationIntegrationAccounts,
  replaceIntegrationResources,
  replaceIntegrationResourcesIfCredentialsMatch,
  replaceRepositories,
  setIntegrationAccountStatus,
  setIntegrationAccountStatusIfCredentialsMatch,
  updateIntegrationAccountCredentials,
  updateIntegrationConnectionStateMetadata,
  upsertIntegrationAccount,
  withIntegrationAccountCredentialLease,
} from "../../../../packages/core/src/db/integrations.js";
import { disableAgentsWithUnavailableRepositories } from "../../../../packages/core/src/db/agents.js";
import {
  beginCustomMcpOAuth,
  finishCustomMcpOAuth,
  parseCustomMcpCredentials,
  validateCustomMcpUrl,
  verifyCustomMcpConnection,
} from "../../../../packages/core/src/integrations/custom-mcp.js";
import {
  createDash0WebhookSecret,
  normalizeDash0McpUrl,
  parseDash0Credentials,
} from "../../../../packages/core/src/integrations/dash0.js";
import {
  parsePostHogCredentials,
  POSTHOG_MCP_URL,
} from "../../../../packages/core/src/integrations/posthog.js";
import { getActiveTenant } from "../tenant.js";
import {
  getIntegrationDefinition,
  integrationCatalog,
  integrationIsConfigured,
  productIntegrationIds,
} from "./catalog.js";
import {
  exchangeGitHubCode,
  GitHubOAuthError,
  githubAuthorizeUrl,
  githubInstallUrl,
  listGitHubUserInstallations,
  listGitHubRepositories,
  verifyGitHubUserInstallation,
} from "./github.js";
import {
  exchangeSlackCode,
  listSlackChannels,
  slackAuthorizeUrl,
} from "./slack.js";
import {
  datadogAccount,
  DatadogCredentialsError,
} from "./datadog.js";
import { getDatadogSite } from "../../../../packages/core/src/integrations/datadog.js";
import {
  AXIOM_MCP_URL,
  parseAxiomCredentials,
} from "../../../../packages/core/src/integrations/axiom.js";
import {
  createLinearPkce,
  exchangeLinearOAuthCode,
  getLinearWorkspace,
  LINEAR_AUTH_VERSION,
  LINEAR_MCP_URL,
  LINEAR_READONLY_MCP_URL,
  linearAuthorizeUrl,
} from "../../../../packages/core/src/integrations/linear.js";
import {
  CLICKSTACK_CLOUD_MCP_URL,
  clickStackAccount,
  clickStackCloudAuthorizeUrl,
  ClickStackCredentialsError,
  ClickStackOAuthError,
  createClickStackPkce,
  exchangeClickStackCloudCode,
  registerClickStackCloudClient,
} from "./clickstack.js";
import {
  deleteSentryInstallation,
  exchangeSentryGrant,
  listSentryProjects,
  refreshSentryGrant,
  SentryApiError,
  sentryErrorNeedsReconnect,
  sentryIntegrationSettingsUrl,
  sentryInstallUrl,
  verifySentryInstallation,
} from "./sentry.js";
import {
  upstashAccount,
  UpstashCredentialsError,
} from "./upstash.js";
import {
  langfuseProject,
  LangfuseCredentialsError,
} from "./langfuse.js";
import {
  exchangeVercelCode,
  getVercelAccount,
  getVercelConfiguration,
  listVercelProjects,
  vercelInstallUrl,
} from "./vercel.js";
import {
  dash0WebhookUrl,
  integrationCallbackUrl,
  settingsRedirect,
} from "./urls.js";
import {
  awsAccountIdSchema,
  awsCloudFormationQuickCreateUrl,
  awsCloudFormationTemplate,
  awsParameterizedCloudFormationTemplate,
  awsConnectionCredentialsSchema,
  createAwsCloudFormationTemplateUrl,
  awsIntegrationPrincipalArn,
  awsInvestigationRoleArn,
  createAwsExternalId,
  verifyAwsInvestigationRole,
} from "../../../../packages/core/src/integrations/aws.js";
import {
  createGcpSessionName,
  gcpConnectionCredentialsSchema,
  gcpProjectIdSchema,
  gcpProjectNumberSchema,
  gcpSetupScript,
  verifyGcpProject,
} from "../../../../packages/core/src/integrations/gcp.js";

const providerSchema = z.enum(productIntegrationIds);
const awsConnectionSchema = z.object({
  accountId: awsAccountIdSchema,
  returnTo: z.string().max(2_048).optional(),
});
const awsVerificationSchema = z.object({
  integrationAccountId: z.uuid(),
  returnTo: z.string().max(2_048).optional(),
});
const gcpConnectionSchema = z.object({
  projectId: gcpProjectIdSchema,
  projectNumber: gcpProjectNumberSchema,
  returnTo: z.string().max(2_048).optional(),
});
const gcpVerificationSchema = z.object({
  integrationAccountId: z.uuid(),
  returnTo: z.string().max(2_048).optional(),
});

function recoverAwsConnectionCredentials(encryptedCredentials: string) {
  try {
    return awsConnectionCredentialsSchema.safeParse(
      decryptCredentials<Record<string, unknown>>(encryptedCredentials),
    );
  } catch {
    return null;
  }
}

function recoverGcpConnectionCredentials(encryptedCredentials: string) {
  try {
    return gcpConnectionCredentialsSchema.safeParse(
      decryptCredentials<Record<string, unknown>>(encryptedCredentials),
    );
  } catch {
    return null;
  }
}
const sentryCredentialsSchema = z.object({
  accessToken: z.string().min(1),
  expiresAt: z.string().nullable().optional(),
  installationId: z.uuid(),
  refreshToken: z.string().min(1),
});

class StoredSentryConnectionError extends Error {
  constructor() {
    super("Stored Sentry connection is invalid");
    this.name = "StoredSentryConnectionError";
  }
}

class SentryConnectionChangedError extends Error {
  constructor() {
    super("Sentry connection changed during refresh");
    this.name = "SentryConnectionChangedError";
  }
}

function getSentryOrganizationSlug(metadata: Record<string, unknown>): string {
  try {
    return z.string().min(1).parse(metadata.organizationSlug);
  } catch {
    throw new StoredSentryConnectionError();
  }
}
const datadogConnectionSchema = z.object({
  apiKey: z.string().trim().min(1).max(512),
  applicationKey: z.string().trim().min(1).max(512),
  returnTo: z.string().max(2_048).optional(),
  site: z.string().min(1),
});
const dash0ConnectionSchema = z.object({
  mcpUrl: z.string().trim().url().max(2_048),
  returnTo: z.string().max(2_048).optional(),
});
const upstashConnectionSchema = z.object({
  apiKey: z.string().trim().min(1).max(4_096),
  email: z.string().trim().email().max(320),
  returnTo: z.string().max(2_048).optional(),
});
const langfuseConnectionSchema = z.object({
  baseUrl: z.string().trim().url().max(2_048),
  publicKey: z.string().trim().min(1).max(512),
  returnTo: z.string().max(2_048).optional(),
  secretKey: z.string().trim().min(1).max(4_096),
});
const customMcpConnectionSchema = z.discriminatedUnion("authType", [
  z.object({
    apiToken: z.string().trim().min(1).max(16_384),
    authType: z.literal("api_token"),
    displayName: z.string().trim().min(1).max(120),
    mcpUrl: z.string().trim().url().max(2_048),
    returnTo: z.string().max(2_048).optional(),
  }),
  z.object({
    authType: z.literal("oauth"),
    displayName: z.string().trim().min(1).max(120),
    mcpUrl: z.string().trim().url().max(2_048),
    returnTo: z.string().max(2_048).optional(),
  }),
]);
const clickStackConnectionSchema = z.discriminatedUnion("deployment", [
  z.object({
    deployment: z.literal("cloud"),
    returnTo: z.string().max(2_048).optional(),
    serviceId: z.uuid(),
  }),
  z.object({
    accessKey: z.string().trim().min(1).max(2_048),
    deployment: z.literal("self_hosted"),
    mcpUrl: z.string().trim().url().max(2_048),
    returnTo: z.string().max(2_048).optional(),
  }),
]);
const vercelCallbackSchema = z.object({
  code: z.string().trim().min(1).max(2_048),
  configurationId: z.string().regex(/^icfg_[A-Za-z0-9]+$/u),
  teamId: z.string().regex(/^team_[A-Za-z0-9]+$/u).optional(),
});

type BrowserOAuthProvider =
  | "axiom"
  | "clickstack"
  | "custom_mcp"
  | "dash0"
  | "gcp"
  | "github"
  | "linear"
  | "posthog"
  | "sentry"
  | "slack"
  | "vercel";

async function consumeBrowserOAuthConnectionState(input: {
  headers: Headers;
  provider: BrowserOAuthProvider;
  state: string;
}): Promise<Awaited<ReturnType<typeof consumeIntegrationConnectionState>>> {
  // Provider state proves that the callback belongs to a flow, but it does not
  // prove that the browser completing that flow is the Responder user who
  // started it. Authenticate before consuming state so signed-out callbacks do
  // not destroy a legitimate user's pending flow.
  const tenant = await getActiveTenant(input.headers);
  if (tenant.ok === false) return null;

  const connectionState = await consumeIntegrationConnectionState(
    input.provider,
    input.state,
    {
      organizationId: tenant.organizationId,
      userId: tenant.user.id,
    },
  );
  if (
    !connectionState ||
    connectionState.userId !== tenant.user.id ||
    connectionState.organizationId !== tenant.organizationId
  ) {
    return null;
  }
  return connectionState;
}

function callbackErrorReason(error: unknown): string {
  if (error instanceof GitHubOAuthError) {
    if (error.githubCode === "incorrect_client_credentials") {
      return "integration_misconfigured";
    }
    if (error.githubCode === "redirect_uri_mismatch") return "callback_mismatch";
    if (error.githubCode === "bad_verification_code") return "expired_code";
    if (error.githubCode === "unverified_user_email") {
      return "unverified_email";
    }
  }
  return "connection_failed";
}

function logCallbackError(
  provider: string,
  error: unknown,
  context?: Record<string, unknown>,
): void {
  const message = error instanceof Error ? error.message : "Unknown integration error";
  const httpStatus = error instanceof SentryApiError
    ? error.httpStatus
    : undefined;
  if (context) {
    console.error(
      JSON.stringify({
        ...context,
        error: message,
        event: "integration_callback_failed",
        ...(httpStatus ? { httpStatus } : {}),
        provider: provider.toLowerCase(),
      }),
    );
  } else {
    console.error(
      JSON.stringify({
        error: message,
        event: "integration_callback_failed",
        ...(httpStatus ? { httpStatus } : {}),
        provider: provider.toLowerCase(),
      }),
    );
  }
}

function logClickStackConnectError(
  error: ClickStackCredentialsError | ClickStackOAuthError,
  organizationId: string,
  deployment: "cloud" | "self_hosted",
): void {
  console.error(
    JSON.stringify({
      deployment,
      error: error.message,
      event: "clickstack_connect_failed",
      organizationId,
      provider: "clickstack",
    }),
  );
}

const safeCustomMcpErrorMessages = new Set([
  "MCP URLs cannot contain credentials",
  "MCP URLs must use HTTPS",
  "MCP URLs must use a public host",
  "MCP URLs must resolve only to public addresses",
  "MCP request redirected too many times",
  "The MCP OAuth access token is missing",
  "The MCP server did not return an access token",
  "The MCP server did not start an OAuth authorization flow",
  "The custom MCP connection is not using OAuth",
  "The custom MCP connection was not updated",
  "The pending custom MCP connection was not found",
]);

function safeCustomMcpErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "UnknownError";
  if (safeCustomMcpErrorMessages.has(error.message)) return error.message;
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code)
    ? `${error.name} (${code})`
    : error.name;
}

function logCustomMcpError(
  stage: "callback" | "connect" | "webhook-config",
  error: unknown,
  accountId?: string,
): void {
  console.error(
    JSON.stringify({
      ...(accountId ? { accountId } : {}),
      errorType: error instanceof Error ? error.name : "UnknownError",
      event: "custom_mcp_connection_failed",
      message: safeCustomMcpErrorMessage(error),
      stage,
    }),
  );
}

type CustomMcpConnectionOutcome =
  | "connected"
  | "oauth_started"
  | "validation_failed"
  | "verify_failed";

export function customMcpConnectionMetricEvent(
  outcome: CustomMcpConnectionOutcome,
  timestamp = Date.now(),
) {
  return {
    _aws: {
      Timestamp: timestamp,
      CloudWatchMetrics: [
        {
          Dimensions: [["outcome"]],
          Metrics: [
            { Name: "custom_mcp.connection.total", Unit: "Count" },
          ],
          Namespace: "Responder",
        },
      ],
    },
    outcome,
    "custom_mcp.connection.total": 1,
  };
}

function recordCustomMcpConnectionOutcome(
  outcome: CustomMcpConnectionOutcome,
): void {
  console.info(JSON.stringify(customMcpConnectionMetricEvent(outcome)));
}

function withIntegrationAccountId(url: string, accountId: string): string {
  const redirect = new URL(url);
  redirect.searchParams.set("integration_account_id", accountId);
  return redirect.toString();
}

async function completeSentrySetup(input: {
  accessToken: string;
  accountId: string;
  expectedEncryptedCredentials?: string;
  installationId: string;
  organizationId?: string;
  organizationSlug: string;
}): Promise<number> {
  const projects = await listSentryProjects(
    input.accessToken,
    input.organizationSlug,
  );
  await verifySentryInstallation(input.accessToken, input.installationId);
  if (input.expectedEncryptedCredentials && input.organizationId) {
    const updated = await replaceIntegrationResourcesIfCredentialsMatch({
      encryptedCredentials: input.expectedEncryptedCredentials,
      integrationAccountId: input.accountId,
      kind: "sentry_project",
      organizationId: input.organizationId,
      provider: "sentry",
      resources: projects,
    });
    if (!updated) throw new SentryConnectionChangedError();
  } else {
    await replaceIntegrationResources(input.accountId, "sentry_project", projects);
    await setIntegrationAccountStatus(input.accountId, "connected");
  }
  return projects.length;
}

async function retrySentrySetup(organizationId: string): Promise<{
  accountId: string;
  resourceCount: number;
} | null> {
  const account = await getRecoverableSentryIntegrationAccount(organizationId);
  if (!account?.encryptedCredentials) return null;
  let expectedEncryptedCredentials = account.encryptedCredentials;
  try {
    const fresh = await getFreshSentryCredentials({
      accountId: account.id,
      allowedStatuses: ["connected", "error", "pending"],
      forceRefresh: true,
      organizationId,
    });
    expectedEncryptedCredentials = fresh.encryptedCredentials;
    const organizationSlug = getSentryOrganizationSlug(account.metadata);
    const resourceCount = await completeSentrySetup({
      accessToken: fresh.credentials.accessToken,
      accountId: account.id,
      expectedEncryptedCredentials,
      installationId: fresh.credentials.installationId,
      organizationId,
      organizationSlug,
    });
    return { accountId: account.id, resourceCount };
  } catch (error) {
    if (
      error instanceof StoredSentryConnectionError ||
      sentryErrorNeedsReconnect(error)
    ) {
      await setIntegrationAccountStatusIfCredentialsMatch({
        encryptedCredentials: expectedEncryptedCredentials,
        integrationAccountId: account.id,
        organizationId,
        provider: "sentry",
        status: "error",
      });
    }
    throw error;
  }
}

async function getFreshSentryCredentials(input: {
  accountId: string;
  allowedStatuses?: Array<"connected" | "error" | "pending">;
  forceRefresh?: boolean;
  organizationId: string;
}) {
  const fresh = await withIntegrationAccountCredentialLease({
    allowedStatuses: input.allowedStatuses ?? ["connected"],
    integrationAccountId: input.accountId,
    organizationId: input.organizationId,
    operation: async (encryptedCredentials) => {
      let current: z.infer<typeof sentryCredentialsSchema>;
      try {
        current = sentryCredentialsSchema.parse(
          decryptCredentials<Record<string, unknown>>(encryptedCredentials),
        );
      } catch {
        throw new StoredSentryConnectionError();
      }
      const expiresAt = current.expiresAt
        ? Date.parse(current.expiresAt)
        : Number.POSITIVE_INFINITY;
      if (
        !input.forceRefresh &&
        Number.isFinite(expiresAt) &&
        expiresAt > Date.now() + 60_000
      ) {
        return {
          value: { credentials: current, encryptedCredentials },
        };
      }

      const authorization = await refreshSentryGrant({
        installationId: current.installationId,
        refreshToken: current.refreshToken,
      });
      const refreshed = {
        accessToken: authorization.token,
        expiresAt: authorization.expiresAt ?? null,
        installationId: current.installationId,
        refreshToken: authorization.refreshToken,
      };
      const refreshedEncryptedCredentials = encryptCredentials(refreshed);
      return {
        encryptedCredentials: refreshedEncryptedCredentials,
        status: "connected" as const,
        value: {
          credentials: refreshed,
          encryptedCredentials: refreshedEncryptedCredentials,
        },
      };
    },
    provider: "sentry",
    statusOnError: (error) =>
      error instanceof StoredSentryConnectionError ||
        sentryErrorNeedsReconnect(error)
        ? "error"
        : undefined,
  });
  if (!fresh) throw new SentryConnectionChangedError();
  return fresh;
}

export const integrationRoutes = new Hono()
  .get("/", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }

    const accounts = await listOrganizationIntegrationAccounts(
      tenant.organizationId,
    );

    return context.json({
      integrations: integrationCatalog.map((definition) => {
        const providerAccounts = accounts.filter(
          (account) => account.provider === definition.id,
        );
        const connectedAccounts = providerAccounts.filter(
          (account) =>
            account.status === "connected" &&
            (definition.id !== "linear" ||
              account.metadata.authVersion === LINEAR_AUTH_VERSION),
        );
        const configured = integrationIsConfigured(definition);
        const resourceCount = providerAccounts.reduce(
          (total, account) => total + account.resourceCount,
          0,
        );

        return {
          id: definition.id,
          name: definition.name,
          description: definition.description,
          state: connectedAccounts.length > 0
            ? "connected"
            : !definition.implemented
              ? "coming_soon"
              : configured
                ? "available"
                : "setup_required",
          accountCount: providerAccounts.length,
          resourceCount,
          accounts: providerAccounts.map((account) => ({
            id: account.id,
            displayName: account.displayName,
            status:
              definition.id === "linear" &&
                account.metadata.authVersion !== LINEAR_AUTH_VERSION
                ? "error"
                : account.status,
            resourceCount: account.resourceCount,
            updatedAt: account.updatedAt,
            ...(definition.id === "gcp"
              ? {
                  projectId: account.externalAccountId,
                  ...(typeof account.metadata.projectNumber === "string"
                    ? { projectNumber: account.metadata.projectNumber }
                    : {}),
                }
              : {}),
          })),
          connectUrl:
            definition.implemented && configured
              ? definition.id === "aws" ||
                  definition.id === "gcp" ||
                  definition.id === "datadog" ||
                  definition.id === "dash0" ||
                  definition.id === "clickstack" ||
                  definition.id === "upstash" ||
                  definition.id === "langfuse"
                ? `/api/integrations/${definition.id}/connect`
                : definition.id === "custom_mcp"
                  ? "/api/integrations/custom-mcp/connect"
                : definition.id === "github" && providerAccounts.length === 0
                  ? "/api/integrations/github/start?mode=install"
                : definition.id === "sentry" && providerAccounts.length > 0
                  ? "/api/integrations/sentry/start"
                  : `/api/integrations/${definition.id}/start`
              : null,
          configurationUrl:
            definition.id === "github" && configured
              ? "/api/integrations/github/start?mode=install"
              : null,
        };
      }),
    });
  })
  .get("/aws/cloudformation-template", (context) =>
    context.body(awsCloudFormationTemplate(), 200, {
      "cache-control": "public, max-age=3600",
      "content-disposition": 'inline; filename="responder-aws-access.yaml"',
      "content-type": "application/yaml; charset=utf-8",
    }),
  )
  .post("/sentry/check", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }

    const accounts = await listConnectedSentryIntegrationAccounts(
      tenant.organizationId,
    );
    const checkedAccounts = await Promise.all(
      accounts.map(async (account) => {
        let expectedEncryptedCredentials = account.encryptedCredentials;
        try {
          if (!account.encryptedCredentials) {
            throw new StoredSentryConnectionError();
          }
          const fresh = await getFreshSentryCredentials({
            accountId: account.id,
            organizationId: tenant.organizationId,
          });
          expectedEncryptedCredentials = fresh.encryptedCredentials;
          const organizationSlug = getSentryOrganizationSlug(account.metadata);
          let projects;
          try {
            projects = await listSentryProjects(
              fresh.credentials.accessToken,
              organizationSlug,
            );
          } catch (error) {
            if (!sentryErrorNeedsReconnect(error)) throw error;
            const recovered = await getFreshSentryCredentials({
              accountId: account.id,
              forceRefresh: true,
              organizationId: tenant.organizationId,
            });
            expectedEncryptedCredentials = recovered.encryptedCredentials;
            projects = await listSentryProjects(
              recovered.credentials.accessToken,
              organizationSlug,
            );
          }
          const updated = await replaceIntegrationResourcesIfCredentialsMatch({
            encryptedCredentials: expectedEncryptedCredentials,
            integrationAccountId: account.id,
            kind: "sentry_project",
            organizationId: tenant.organizationId,
            provider: "sentry",
            resources: projects,
          });
          if (!updated) throw new SentryConnectionChangedError();
          return {
            id: account.id,
            resourceCount: projects.length,
            status: "working" as const,
          };
        } catch (error) {
          const needsReconnect =
            error instanceof StoredSentryConnectionError ||
            sentryErrorNeedsReconnect(error);
          if (needsReconnect) {
            if (expectedEncryptedCredentials) {
              await setIntegrationAccountStatusIfCredentialsMatch({
                encryptedCredentials: expectedEncryptedCredentials,
                integrationAccountId: account.id,
                organizationId: tenant.organizationId,
                provider: "sentry",
                status: "error",
              });
            }
          }
          console.error(
            JSON.stringify({
              error: error instanceof Error ? error.message : "Unknown error",
              event: "sentry_connection_check_failed",
              ...(error instanceof SentryApiError
                ? { httpStatus: error.httpStatus }
                : {}),
              integrationAccountId: account.id,
              organizationId: tenant.organizationId,
              status: needsReconnect ? "needs_reconnect" : "unavailable",
            }),
          );
          return {
            id: account.id,
            status: needsReconnect
              ? "needs_reconnect" as const
              : "unavailable" as const,
          };
        }
      }),
    );

    return context.json({ accounts: checkedAccounts });
  })
  .delete("/sentry/:integrationAccountId", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }
    const accountId = z.uuid().safeParse(context.req.param("integrationAccountId"));
    if (!accountId.success) {
      return context.json({ error: "The Sentry account is invalid" }, 400);
    }
    const localOnly = context.req.query("localOnly") === "true";
    const account = await getOrganizationIntegrationAccount({
      integrationAccountId: accountId.data,
      organizationId: tenant.organizationId,
      provider: "sentry",
    });
    if (!account) {
      if (localOnly) return context.json({ removed: true });
      return context.json({ error: "Sentry connection not found" }, 404);
    }

    const manualUninstallUrl = sentryIntegrationSettingsUrl(
      typeof account.metadata.organizationSlug === "string"
        ? account.metadata.organizationSlug
        : "",
    );
    if (localOnly) {
      await deleteIntegrationAccount({
        integrationAccountId: account.id,
        organizationId: tenant.organizationId,
        provider: "sentry",
      });
      return context.json({ removed: true });
    }

    try {
      if (!account.encryptedCredentials) {
        throw new StoredSentryConnectionError();
      }
      const fresh = await getFreshSentryCredentials({
        accountId: account.id,
        allowedStatuses: ["connected", "error", "pending"],
        organizationId: tenant.organizationId,
      });
      await deleteSentryInstallation(
        fresh.credentials.accessToken,
        fresh.credentials.installationId,
      );
      await deleteIntegrationAccount({
        integrationAccountId: account.id,
        organizationId: tenant.organizationId,
        provider: "sentry",
      });
      return context.json({ removed: true });
    } catch (error) {
      if (
        error instanceof StoredSentryConnectionError ||
        sentryErrorNeedsReconnect(error)
      ) {
        return context.json(
          {
            action: "manual_uninstall_required" as const,
            error:
              "Sentry requires an organization admin to uninstall this connection before it can be reconnected.",
            manualUninstallUrl,
          },
          409,
        );
      }
      logCallbackError("Sentry uninstall", error, {
        integrationAccountId: account.id,
        organizationId: tenant.organizationId,
      });
      return context.json({ error: "Unable to disconnect Sentry" }, 502);
    }
  })
  .get("/:provider/start", async (context) => {
    const parsedProvider = providerSchema.safeParse(context.req.param("provider"));
    if (!parsedProvider.success) {
      return context.json({ error: "Unknown integration provider" }, 404);
    }

    const definition = getIntegrationDefinition(parsedProvider.data);
    if (!definition?.implemented) {
      return context.json({ error: "Integration is not available yet" }, 501);
    }
    if (!integrationIsConfigured(definition)) {
      return context.json({ error: "Integration application is not configured" }, 503);
    }

    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }
    if (
      parsedProvider.data === "aws" ||
      parsedProvider.data === "gcp" ||
      parsedProvider.data === "datadog" ||
      parsedProvider.data === "dash0" ||
      parsedProvider.data === "clickstack" ||
      parsedProvider.data === "upstash" ||
      parsedProvider.data === "langfuse"
    ) {
      return context.json(
        { error: `Use the ${definition.name} connection endpoint` },
        405,
      );
    }
    if (parsedProvider.data === "custom_mcp") {
      return context.json(
        { error: "Use the custom MCP connection endpoint" },
        405,
      );
    }
    if (parsedProvider.data === "sentry") {
      try {
        const retriedAccount = await retrySentrySetup(tenant.organizationId);
        if (retriedAccount) {
          await captureAnalyticsEvent({
            distinctId: tenant.user.id,
            event: "integration connected",
            organizationId: tenant.organizationId,
            properties: {
              integration_account_id: retriedAccount.accountId,
              provider: "sentry",
              resource_count: retriedAccount.resourceCount,
            },
          });
          return context.redirect(
            settingsRedirect(
              context.req.query("returnTo") ?? "/settings",
              "sentry",
              "connected",
            ),
          );
        }
      } catch (error) {
        logCallbackError("Sentry retry", error);
        if (
          error instanceof StoredSentryConnectionError ||
          sentryErrorNeedsReconnect(error)
        ) {
          return context.redirect(
            settingsRedirect(
              context.req.query("returnTo") ?? "/settings",
              "sentry",
              "error",
              "manual_uninstall_required",
            ),
          );
        }
      }
    }
    if (parsedProvider.data === "linear") {
      try {
        const pkce = createLinearPkce();
        const linearState = await createIntegrationConnectionState({
          organizationId: tenant.organizationId,
          userId: tenant.user.id,
          provider: "linear",
          codeVerifier: pkce.codeVerifier,
          returnTo: context.req.query("returnTo"),
          routingUrl: integrationCallbackUrl("linear"),
        });
        return context.redirect(
          linearAuthorizeUrl({
            codeChallenge: pkce.codeChallenge,
            redirectUri: integrationCallbackUrl("linear"),
            state: linearState,
          }),
        );
      } catch (error) {
        logCustomMcpError("connect", error);
        return context.redirect(
          settingsRedirect(
            context.req.query("returnTo") ?? "/settings",
            "linear",
            "error",
            "connection_failed",
          ),
        );
      }
    }
    if (parsedProvider.data === "axiom") {
      let accountId: string | undefined;
      let preserveExistingAccount = false;
      try {
        const existing = await getOrganizationIntegrationAccountByExternalId({
          externalAccountId: AXIOM_MCP_URL,
          organizationId: tenant.organizationId,
          provider: "axiom",
        });
        preserveExistingAccount = Boolean(existing);
        accountId =
          existing?.id ??
          (await upsertIntegrationAccount({
            organizationId: tenant.organizationId,
            provider: "axiom",
            externalAccountId: AXIOM_MCP_URL,
            displayName: "Axiom",
            encryptedCredentials: encryptCredentials({
              authType: "oauth",
              mcpUrl: AXIOM_MCP_URL,
              oauth: {},
            }),
            credentialKeyVersion: 1,
            metadata: { authType: "oauth", mcpUrl: AXIOM_MCP_URL },
            status: "pending",
          }));
        const connectionState = await createIntegrationConnectionState({
          organizationId: tenant.organizationId,
          userId: tenant.user.id,
          provider: "axiom",
          codeVerifier: JSON.stringify({ accountId, preserveExistingAccount }),
          returnTo: context.req.query("returnTo"),
          routingUrl: integrationCallbackUrl("axiom"),
        });
        const oauthResult = await beginCustomMcpOAuth({
          connectionState,
          mcpUrl: AXIOM_MCP_URL,
          redirectUrl: integrationCallbackUrl("axiom"),
        });
        const updated = await updateIntegrationConnectionStateMetadata({
          metadata: {
            encryptedCredentials: encryptCredentials({
              authType: "oauth",
              mcpUrl: AXIOM_MCP_URL,
              oauth: oauthResult.oauth,
            }),
          },
          organizationId: tenant.organizationId,
          provider: "axiom",
          state: connectionState,
          userId: tenant.user.id,
        });
        if (!updated) throw new Error("The Axiom OAuth state was not updated");
        return context.redirect(oauthResult.authorizationUrl);
      } catch (error) {
        logCustomMcpError("connect", error, accountId);
        if (accountId && !preserveExistingAccount) {
          await setIntegrationAccountStatus(accountId, "error").catch(
            () => undefined,
          );
        }
        return context.redirect(
          settingsRedirect(
            context.req.query("returnTo") ?? "/settings",
            "axiom",
            "error",
            "connection_failed",
          ),
        );
      }
    }
    if (parsedProvider.data === "posthog") {
      let accountId: string | undefined;
      try {
        const externalAccountId = randomUUID();
        accountId = await upsertIntegrationAccount({
          organizationId: tenant.organizationId,
          provider: "posthog",
          externalAccountId,
          displayName: "PostHog",
          encryptedCredentials: encryptCredentials({
            authType: "oauth",
            mcpUrl: POSTHOG_MCP_URL,
            oauth: {},
          }),
          credentialKeyVersion: 1,
          metadata: { authType: "oauth", mcpUrl: POSTHOG_MCP_URL },
          status: "pending",
        });
        const connectionState = await createIntegrationConnectionState({
          organizationId: tenant.organizationId,
          userId: tenant.user.id,
          provider: "posthog",
          codeVerifier: JSON.stringify({ accountId, externalAccountId }),
          returnTo: context.req.query("returnTo"),
          routingUrl: integrationCallbackUrl("posthog"),
        });
        const oauthResult = await beginCustomMcpOAuth({
          connectionState,
          mcpUrl: POSTHOG_MCP_URL,
          redirectUrl: integrationCallbackUrl("posthog"),
        });
        const updated = await updateIntegrationAccountCredentials({
          encryptedCredentials: encryptCredentials({
            authType: "oauth",
            mcpUrl: POSTHOG_MCP_URL,
            oauth: oauthResult.oauth,
          }),
          integrationAccountId: accountId,
          organizationId: tenant.organizationId,
          provider: "posthog",
          status: "pending",
        });
        if (!updated) throw new Error("The pending PostHog connection was not updated");
        return context.redirect(oauthResult.authorizationUrl);
      } catch (error) {
        if (accountId) {
          await setIntegrationAccountStatus(accountId, "error").catch(
            () => undefined,
          );
        }
        logCustomMcpError("connect", error, accountId);
        return context.redirect(
          settingsRedirect(
            context.req.query("returnTo") ?? "/settings",
            "posthog",
            "error",
            "connection_failed",
          ),
        );
      }
    }
    const state = await createIntegrationConnectionState({
      organizationId: tenant.organizationId,
      userId: tenant.user.id,
      provider: parsedProvider.data,
      returnTo: context.req.query("returnTo"),
      routingUrl:
        parsedProvider.data === "github" ||
        parsedProvider.data === "sentry" ||
        parsedProvider.data === "vercel"
          ? integrationCallbackUrl(parsedProvider.data)
          : undefined,
    });

    if (parsedProvider.data === "slack") {
      return context.redirect(slackAuthorizeUrl(state));
    }
    if (parsedProvider.data === "sentry") {
      return context.redirect(sentryInstallUrl(state));
    }
    if (parsedProvider.data === "github") {
      if (context.req.query("mode") === "install") {
        return context.redirect(githubInstallUrl(state));
      }
      return context.redirect(githubAuthorizeUrl(state));
    }
    if (parsedProvider.data === "vercel") {
      return context.redirect(vercelInstallUrl(state));
    }

    return context.json({ error: "Integration is not available yet" }, 501);
  })
  .post("/aws/connect", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }
    const parsed = awsConnectionSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return context.json({ error: "Enter a 12-digit AWS account ID" }, 400);
    }

    try {
      const principalArn = awsIntegrationPrincipalArn();
      const existing = await getOrganizationIntegrationAccountByExternalId({
        externalAccountId: parsed.data.accountId,
        organizationId: tenant.organizationId,
        provider: "aws",
      });
      const existingCredentials = existing?.encryptedCredentials
        ? recoverAwsConnectionCredentials(existing.encryptedCredentials)
        : null;
      const externalId = existingCredentials?.success
        ? existingCredentials.data.externalId
        : createAwsExternalId();
      const credentials = {
        accountId: parsed.data.accountId,
        externalId,
        roleArn: awsInvestigationRoleArn(parsed.data.accountId),
      };
      const accountId =
        existing?.status === "connected" && existingCredentials?.success
          ? existing.id
          : await upsertIntegrationAccount({
              organizationId: tenant.organizationId,
              provider: "aws",
              externalAccountId: parsed.data.accountId,
              displayName: `AWS · ${parsed.data.accountId}`,
              encryptedCredentials: encryptCredentials(credentials),
              credentialKeyVersion: 1,
              metadata: {
                permissionPolicy: "AIOpsAssistantPolicy",
                roleName: "ResponderInvestigationRole",
              },
              status: "pending",
            });
      const templateUrl = await createAwsCloudFormationTemplateUrl();
      return context.json({
        accountId,
        cloudFormationUrl: templateUrl
          ? awsCloudFormationQuickCreateUrl({
              externalId,
              principalArn,
              templateUrl,
            })
          : null,
        template: awsParameterizedCloudFormationTemplate({
          externalId,
          principalArn,
        }),
      });
    } catch (error) {
      logCallbackError("AWS", error, {
        organizationId: tenant.organizationId,
        stage: "setup",
      });
      return context.json(
        { error: "Unable to prepare the AWS connection" },
        502,
      );
    }
  })
  .post("/aws/verify", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }
    const parsed = awsVerificationSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return context.json({ error: "The AWS setup session is invalid" }, 400);
    }

    const account = await getOrganizationIntegrationAccount({
      integrationAccountId: parsed.data.integrationAccountId,
      organizationId: tenant.organizationId,
      provider: "aws",
    });
    if (!account?.encryptedCredentials) {
      return context.json({ error: "Start the AWS connection again" }, 404);
    }
    try {
      const credentials = awsConnectionCredentialsSchema.parse(
        decryptCredentials<Record<string, unknown>>(account.encryptedCredentials),
      );
      await verifyAwsInvestigationRole(credentials);
      await setIntegrationAccountStatus(account.id, "connected");
      await captureAnalyticsEvent({
        distinctId: tenant.user.id,
        event: "integration connected",
        organizationId: tenant.organizationId,
        properties: {
          integration_account_id: account.id,
          provider: "aws",
        },
      });
      return context.json({
        accountId: account.id,
        redirectUrl: withIntegrationAccountId(
          settingsRedirect(
            parsed.data.returnTo ?? "/settings",
            "aws",
            "connected",
          ),
          account.id,
        ),
      });
    } catch (error) {
      await setIntegrationAccountStatus(account.id, "error");
      logCallbackError("AWS", error, {
        accountId: account.id,
        organizationId: tenant.organizationId,
        stage: "verify",
      });
      return context.json(
        {
          error:
            "Responder could not assume the role yet. Wait for the CloudFormation stack to finish, then try again.",
        },
        401,
      );
    }
  })
  .delete("/gcp/:integrationAccountId", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }
    const accountId = z.uuid().safeParse(context.req.param("integrationAccountId"));
    if (!accountId.success) {
      return context.json({ error: "The Google Cloud account is invalid" }, 400);
    }
    const deleted = await deleteIntegrationAccount({
      integrationAccountId: accountId.data,
      organizationId: tenant.organizationId,
      provider: "gcp",
    });
    if (!deleted) {
      return context.json({ error: "Google Cloud project connection not found" }, 404);
    }
    return context.json({ removed: true });
  })
  .post("/gcp/connect", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }
    const parsed = gcpConnectionSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return context.json(
        { error: "Enter a valid Google Cloud project ID and project number" },
        400,
      );
    }

    try {
      const existing = await getOrganizationIntegrationAccountByExternalId({
        externalAccountId: parsed.data.projectId,
        organizationId: tenant.organizationId,
        provider: "gcp",
      });
      const existingCredentials = existing?.encryptedCredentials
        ? recoverGcpConnectionCredentials(existing.encryptedCredentials)
        : null;
      const credentials = {
        projectId: parsed.data.projectId,
        projectNumber: parsed.data.projectNumber,
        sessionName: existingCredentials?.success
          ? existingCredentials.data.sessionName
          : createGcpSessionName(),
      };
      const accountId =
        existing?.status === "connected" && existingCredentials?.success &&
          existingCredentials.data.projectNumber === parsed.data.projectNumber
          ? existing.id
          : await upsertIntegrationAccount({
              organizationId: tenant.organizationId,
              provider: "gcp",
              externalAccountId: parsed.data.projectId,
              displayName: `GCP · ${parsed.data.projectId}`,
              encryptedCredentials: encryptCredentials(credentials),
              credentialKeyVersion: 1,
              metadata: {
                permissionRoles: [
                  "roles/cloudasset.viewer",
                  "roles/logging.viewer",
                  "roles/monitoring.viewer",
                ],
                projectNumber: parsed.data.projectNumber,
                serviceAccountId: "responder-investigation",
              },
              status: "pending",
            });
      return context.json({
        accountId,
        projectId: parsed.data.projectId,
        script: gcpSetupScript(credentials),
      });
    } catch (error) {
      logCallbackError("GCP", error, {
        organizationId: tenant.organizationId,
        stage: "setup",
      });
      return context.json(
        { error: "Unable to prepare the Google Cloud connection" },
        502,
      );
    }
  })
  .post("/gcp/verify", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }
    const parsed = gcpVerificationSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return context.json({ error: "The Google Cloud setup session is invalid" }, 400);
    }

    const account = await getOrganizationIntegrationAccount({
      integrationAccountId: parsed.data.integrationAccountId,
      organizationId: tenant.organizationId,
      provider: "gcp",
    });
    if (!account?.encryptedCredentials) {
      return context.json({ error: "Start the Google Cloud connection again" }, 404);
    }
    try {
      const credentials = gcpConnectionCredentialsSchema.parse(
        decryptCredentials<Record<string, unknown>>(account.encryptedCredentials),
      );
      await verifyGcpProject(credentials);
      await setIntegrationAccountStatus(account.id, "connected");
      await captureAnalyticsEvent({
        distinctId: tenant.user.id,
        event: "integration connected",
        organizationId: tenant.organizationId,
        properties: {
          integration_account_id: account.id,
          provider: "gcp",
        },
      });
      return context.json({
        accountId: account.id,
        redirectUrl: withIntegrationAccountId(
          settingsRedirect(
            parsed.data.returnTo ?? "/settings",
            "gcp",
            "connected",
          ),
          account.id,
        ),
      });
    } catch (error) {
      await setIntegrationAccountStatus(account.id, "error");
      logCallbackError("GCP", error, {
        accountId: account.id,
        organizationId: tenant.organizationId,
        stage: "verify",
      });
      return context.json(
        {
          error:
            "Responder could not use the Google Cloud identity yet. Wait for the setup script to finish, then try again.",
        },
        401,
      );
    }
  })
  .post("/datadog/connect", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }

    const parsed = datadogConnectionSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return context.json({ error: "Enter both Datadog keys and choose a site" }, 400);
    }

    try {
      const site = getDatadogSite(parsed.data.site);
      const account = await datadogAccount({
        apiKey: parsed.data.apiKey,
        applicationKey: parsed.data.applicationKey,
        site,
      });
      const accountId = await upsertIntegrationAccount({
        organizationId: tenant.organizationId,
        provider: "datadog",
        externalAccountId: account.externalAccountId,
        displayName: account.displayName,
        encryptedCredentials: encryptCredentials({
          authType: "api_keys",
          apiKey: parsed.data.apiKey,
          applicationKey: parsed.data.applicationKey,
          datacenter: site.name,
          mcpUrl: site.mcpUrl,
          site: site.id,
        }),
        credentialKeyVersion: 1,
        metadata: account.metadata,
      });
      await captureAnalyticsEvent({
        distinctId: tenant.user.id,
        event: "integration connected",
        organizationId: tenant.organizationId,
        properties: {
          integration_account_id: accountId,
          provider: "datadog",
        },
      });
      console.info("Datadog API key connection completed", {
        accountId,
        site: site.name,
      });
      return context.json({
        accountId,
        redirectUrl: settingsRedirect(
          parsed.data.returnTo ?? "/settings",
          "datadog",
          "connected",
        ),
      });
    } catch (error) {
      if (error instanceof DatadogCredentialsError) {
        return context.json({ error: error.message }, 401);
      }
      logCallbackError("Datadog", error);
      return context.json(
        { error: "Unable to verify the Datadog connection" },
        502,
      );
    }
  })
  .post("/dash0/connect", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }

    const parsed = dash0ConnectionSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return context.json({ error: "Enter the MCP endpoint copied from Dash0" }, 400);
    }

    let accountId: string | undefined;
    try {
      const mcpUrl = await normalizeDash0McpUrl(parsed.data.mcpUrl);
      const externalAccountId = randomUUID();
      const webhookSecret = createDash0WebhookSecret();
      accountId = await upsertIntegrationAccount({
        organizationId: tenant.organizationId,
        provider: "dash0",
        externalAccountId,
        displayName: "Dash0",
        encryptedCredentials: encryptCredentials({
          authType: "oauth",
          mcpUrl,
          oauth: {},
          webhookSecret,
        }),
        credentialKeyVersion: 1,
        metadata: { authType: "oauth", mcpUrl },
        status: "pending",
      });
      const connectionState = await createIntegrationConnectionState({
        organizationId: tenant.organizationId,
        userId: tenant.user.id,
        provider: "dash0",
        codeVerifier: JSON.stringify({ accountId, externalAccountId }),
        returnTo: parsed.data.returnTo,
        routingUrl: integrationCallbackUrl("dash0"),
      });
      const oauthResult = await beginCustomMcpOAuth({
        connectionState,
        mcpUrl,
        redirectUrl: integrationCallbackUrl("dash0"),
      });
      const updated = await updateIntegrationAccountCredentials({
        encryptedCredentials: encryptCredentials({
          authType: "oauth",
          mcpUrl,
          oauth: oauthResult.oauth,
          webhookSecret,
        }),
        integrationAccountId: accountId,
        organizationId: tenant.organizationId,
        provider: "dash0",
        status: "pending",
      });
      if (!updated) throw new Error("The pending Dash0 connection was not updated");
      return context.json({ redirectUrl: oauthResult.authorizationUrl });
    } catch (error) {
      if (accountId) {
        await setIntegrationAccountStatus(accountId, "error").catch(
          () => undefined,
        );
      }
      logCustomMcpError("connect", error, accountId);
      return context.json({ error: "Unable to start Dash0 OAuth" }, 502);
    }
  })
  .get("/dash0/callback", async (context) => {
    const state = context.req.query("state");
    if (!state) {
      return context.redirect(
        settingsRedirect("/settings", "dash0", "error", "invalid_state"),
      );
    }

    let connectionState: Awaited<
      ReturnType<typeof consumeIntegrationConnectionState>
    > = null;
    let accountId: string | undefined;
    try {
      connectionState = await consumeBrowserOAuthConnectionState({
        headers: context.req.raw.headers,
        provider: "dash0",
        state,
      });
      if (!connectionState) {
        return context.redirect(
          settingsRedirect("/settings", "dash0", "error", "invalid_state"),
        );
      }
      const callbackState = z
        .object({ accountId: z.uuid(), externalAccountId: z.uuid() })
        .parse(JSON.parse(connectionState.codeVerifier ?? "null"));
      accountId = callbackState.accountId;
      const authorizationCode = z.string().min(1).parse(context.req.query("code"));
      const account = await getOrganizationIntegrationAccount({
        integrationAccountId: accountId,
        organizationId: connectionState.organizationId,
        provider: "dash0",
      });
      if (!account?.encryptedCredentials || account.status !== "pending") {
        throw new Error("The pending Dash0 connection was not found");
      }
      const credentials = parseDash0Credentials(
        decryptCredentials<Record<string, unknown>>(account.encryptedCredentials),
      );
      const oauth = await finishCustomMcpOAuth({
        authorizationCode,
        mcpUrl: credentials.mcpUrl,
        oauth: credentials.oauth,
        redirectUrl: integrationCallbackUrl("dash0"),
      });
      const accessToken = oauth.tokens?.access_token;
      if (!accessToken) throw new Error("The Dash0 OAuth access token is missing");
      const toolCount = await verifyCustomMcpConnection({
        accessToken,
        mcpUrl: credentials.mcpUrl,
      });
      const connectedAccountId = await upsertIntegrationAccount({
        organizationId: connectionState.organizationId,
        provider: "dash0",
        externalAccountId: callbackState.externalAccountId,
        displayName: "Dash0",
        encryptedCredentials: encryptCredentials({ ...credentials, oauth }),
        credentialKeyVersion: 1,
        metadata: {
          authType: "oauth",
          mcpUrl: credentials.mcpUrl,
          toolCount,
        },
        status: "connected",
      });
      if (connectedAccountId !== accountId) {
        throw new Error("The Dash0 connection changed during OAuth");
      }
      await captureAnalyticsEvent({
        distinctId: connectionState.userId,
        event: "integration connected",
        organizationId: connectionState.organizationId,
        properties: {
          integration_account_id: accountId,
          provider: "dash0",
          tool_count: toolCount,
        },
      });
      return context.redirect(
        withIntegrationAccountId(
          settingsRedirect(connectionState.returnTo, "dash0", "connected"),
          accountId,
        ),
      );
    } catch (error) {
      logCustomMcpError("callback", error, accountId);
      if (accountId) {
        await setIntegrationAccountStatus(accountId, "error").catch(
          () => undefined,
        );
      }
      return context.redirect(
        settingsRedirect(
          connectionState?.returnTo ?? "/settings",
          "dash0",
          "error",
          context.req.query("error") ? "cancelled" : "connection_failed",
        ),
      );
    }
  })
  .get("/dash0/:accountId/webhook-config", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }
    const accountId = z.uuid().safeParse(context.req.param("accountId"));
    if (!accountId.success) {
      return context.json({ error: "Dash0 connection not found" }, 404);
    }
    const account = await getOrganizationIntegrationAccount({
      integrationAccountId: accountId.data,
      organizationId: tenant.organizationId,
      provider: "dash0",
    });
    if (!account?.encryptedCredentials || account.status !== "connected") {
      return context.json({ error: "Dash0 connection not found" }, 404);
    }
    try {
      const credentials = parseDash0Credentials(
        decryptCredentials<Record<string, unknown>>(account.encryptedCredentials),
      );
      context.header("cache-control", "no-store");
      return context.json({
        authorization: `Bearer ${credentials.webhookSecret}`,
        webhookUrl: dash0WebhookUrl(accountId.data),
      });
    } catch (error) {
      logCustomMcpError("webhook-config", error, accountId.data);
      return context.json({ error: "Unable to load Dash0 webhook setup" }, 500);
    }
  })
  .get("/posthog/callback", async (context) => {
    const state = context.req.query("state");
    if (!state) {
      return context.redirect(
        settingsRedirect("/settings", "posthog", "error", "invalid_state"),
      );
    }

    let connectionState: Awaited<
      ReturnType<typeof consumeIntegrationConnectionState>
    > = null;
    let accountId: string | undefined;
    try {
      connectionState = await consumeBrowserOAuthConnectionState({
        headers: context.req.raw.headers,
        provider: "posthog",
        state,
      });
      if (!connectionState) {
        return context.redirect(
          settingsRedirect("/settings", "posthog", "error", "invalid_state"),
        );
      }
      const callbackState = z
        .object({ accountId: z.uuid(), externalAccountId: z.uuid() })
        .parse(JSON.parse(connectionState.codeVerifier ?? "null"));
      accountId = callbackState.accountId;
      const authorizationCode = z.string().min(1).parse(context.req.query("code"));
      const account = await getOrganizationIntegrationAccount({
        integrationAccountId: accountId,
        organizationId: connectionState.organizationId,
        provider: "posthog",
      });
      if (!account?.encryptedCredentials || account.status !== "pending") {
        throw new Error("The pending PostHog connection was not found");
      }
      const credentials = parsePostHogCredentials(
        decryptCredentials<Record<string, unknown>>(account.encryptedCredentials),
      );
      const oauth = await finishCustomMcpOAuth({
        authorizationCode,
        mcpUrl: credentials.mcpUrl,
        oauth: credentials.oauth,
        redirectUrl: integrationCallbackUrl("posthog"),
      });
      const accessToken = oauth.tokens?.access_token;
      if (!accessToken) throw new Error("The PostHog OAuth access token is missing");
      const toolCount = await verifyCustomMcpConnection({
        accessToken,
        mcpUrl: credentials.mcpUrl,
      });
      const connectedAccountId = await upsertIntegrationAccount({
        organizationId: connectionState.organizationId,
        provider: "posthog",
        externalAccountId: callbackState.externalAccountId,
        displayName: "PostHog",
        encryptedCredentials: encryptCredentials({ ...credentials, oauth }),
        credentialKeyVersion: 1,
        metadata: {
          authType: "oauth",
          mcpUrl: credentials.mcpUrl,
          toolCount,
        },
        status: "connected",
      });
      if (connectedAccountId !== accountId) {
        throw new Error("The PostHog connection changed during OAuth");
      }
      await captureAnalyticsEvent({
        distinctId: connectionState.userId,
        event: "integration connected",
        organizationId: connectionState.organizationId,
        properties: {
          integration_account_id: accountId,
          provider: "posthog",
          tool_count: toolCount,
        },
      });
      return context.redirect(
        withIntegrationAccountId(
          settingsRedirect(connectionState.returnTo, "posthog", "connected"),
          accountId,
        ),
      );
    } catch (error) {
      logCustomMcpError("callback", error, accountId);
      if (accountId) {
        await setIntegrationAccountStatus(accountId, "error").catch(
          () => undefined,
        );
      }
      return context.redirect(
        settingsRedirect(
          connectionState?.returnTo ?? "/settings",
          "posthog",
          "error",
          context.req.query("error") ? "cancelled" : "connection_failed",
        ),
      );
    }
  })
  .get("/axiom/callback", async (context) => {
    const state = context.req.query("state");
    if (!state) {
      return context.redirect(
        settingsRedirect("/settings", "axiom", "error", "invalid_state"),
      );
    }

    let connectionState: Awaited<
      ReturnType<typeof consumeIntegrationConnectionState>
    > = null;
    let accountId: string | undefined;
    let preserveExistingAccount = false;
    try {
      connectionState = await consumeBrowserOAuthConnectionState({
        headers: context.req.raw.headers,
        provider: "axiom",
        state,
      });
      if (!connectionState) {
        return context.redirect(
          settingsRedirect("/settings", "axiom", "error", "invalid_state"),
        );
      }
      const callbackState = z
        .object({
          accountId: z.uuid(),
          preserveExistingAccount: z.boolean().default(false),
        })
        .parse(JSON.parse(connectionState.codeVerifier ?? "null"));
      accountId = callbackState.accountId;
      preserveExistingAccount = callbackState.preserveExistingAccount;
      const authorizationCode = z.string().min(1).parse(context.req.query("code"));
      const account = await getOrganizationIntegrationAccount({
        integrationAccountId: accountId,
        organizationId: connectionState.organizationId,
        provider: "axiom",
      });
      if (!account || (!preserveExistingAccount && account.status !== "pending")) {
        throw new Error("The pending Axiom connection was not found");
      }
      const pendingCredentials = z
        .object({ encryptedCredentials: z.string().min(1) })
        .parse(connectionState.metadata);
      const credentials = parseAxiomCredentials(
        decryptCredentials<Record<string, unknown>>(
          pendingCredentials.encryptedCredentials,
        ),
      );
      const oauth = await finishCustomMcpOAuth({
        authorizationCode,
        mcpUrl: credentials.mcpUrl,
        oauth: credentials.oauth,
        redirectUrl: integrationCallbackUrl("axiom"),
      });
      const accessToken = oauth.tokens?.access_token;
      if (!accessToken) throw new Error("The Axiom OAuth access token is missing");
      const toolCount = await verifyCustomMcpConnection({
        accessToken,
        mcpUrl: credentials.mcpUrl,
      });
      const updated = await updateIntegrationAccountCredentials({
        encryptedCredentials: encryptCredentials({
          authType: "oauth",
          mcpUrl: credentials.mcpUrl,
          oauth,
        }),
        integrationAccountId: accountId,
        organizationId: connectionState.organizationId,
        provider: "axiom",
        status: "connected",
      });
      if (!updated) throw new Error("The Axiom connection was not updated");
      await captureAnalyticsEvent({
        distinctId: connectionState.userId,
        event: "integration connected",
        organizationId: connectionState.organizationId,
        properties: {
          integration_account_id: accountId,
          provider: "axiom",
          tool_count: toolCount,
        },
      });
      return context.redirect(
        withIntegrationAccountId(
          settingsRedirect(connectionState.returnTo, "axiom", "connected"),
          accountId,
        ),
      );
    } catch (error) {
      logCustomMcpError("callback", error, accountId);
      if (accountId && !preserveExistingAccount) {
        await setIntegrationAccountStatus(accountId, "error").catch(
          () => undefined,
        );
      }
      return context.redirect(
        settingsRedirect(
          connectionState?.returnTo ?? "/settings",
          "axiom",
          "error",
          context.req.query("error") ? "cancelled" : "connection_failed",
        ),
      );
    }
  })
  .post("/upstash/connect", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }

    const parsed = upstashConnectionSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return context.json(
        { error: "Enter your Upstash account email and API key" },
        400,
      );
    }

    try {
      const account = await upstashAccount(parsed.data);
      const accountId = await upsertIntegrationAccount({
        organizationId: tenant.organizationId,
        provider: "upstash",
        externalAccountId: account.externalAccountId,
        displayName: account.displayName,
        encryptedCredentials: encryptCredentials({
          apiKey: parsed.data.apiKey,
          authType: "api_key",
          email: account.externalAccountId,
        }),
        credentialKeyVersion: 1,
        metadata: account.metadata,
      });
      await captureAnalyticsEvent({
        distinctId: tenant.user.id,
        event: "integration connected",
        organizationId: tenant.organizationId,
        properties: {
          integration_account_id: accountId,
          provider: "upstash",
        },
      });
      console.info(
        JSON.stringify({
          accountId,
          event: "upstash_connected",
          organizationId: tenant.organizationId,
          provider: "upstash",
        }),
      );
      return context.json({
        accountId,
        redirectUrl: withIntegrationAccountId(
          settingsRedirect(
            parsed.data.returnTo ?? "/settings",
            "upstash",
            "connected",
          ),
          accountId,
        ),
      });
    } catch (error) {
      if (error instanceof UpstashCredentialsError) {
        return context.json({ error: error.message }, 401);
      }
      logCallbackError("Upstash", error, {
        organizationId: tenant.organizationId,
      });
      return context.json(
        { error: "Unable to verify the Upstash connection" },
        502,
      );
    }
  })
  .post("/langfuse/connect", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }

    const parsed = langfuseConnectionSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return context.json(
        { error: "Enter the Langfuse deployment URL and project API keys" },
        400,
      );
    }

    try {
      const project = await langfuseProject(parsed.data);
      const accountId = await upsertIntegrationAccount({
        organizationId: tenant.organizationId,
        provider: "langfuse",
        externalAccountId: project.externalAccountId,
        displayName: project.displayName,
        encryptedCredentials: encryptCredentials({
          authType: "basic",
          baseUrl: project.baseUrl,
          projectId: project.projectId,
          publicKey: parsed.data.publicKey,
          secretKey: parsed.data.secretKey,
        }),
        credentialKeyVersion: 1,
        metadata: project.metadata,
      });
      await captureAnalyticsEvent({
        distinctId: tenant.user.id,
        event: "integration connected",
        organizationId: tenant.organizationId,
        properties: {
          integration_account_id: accountId,
          provider: "langfuse",
        },
      });
      console.info(
        JSON.stringify({
          accountId,
          event: "langfuse_connected",
          organizationId: tenant.organizationId,
          projectId: project.projectId,
          provider: "langfuse",
        }),
      );
      return context.json({
        accountId,
        redirectUrl: withIntegrationAccountId(
          settingsRedirect(
            parsed.data.returnTo ?? "/settings",
            "langfuse",
            "connected",
          ),
          accountId,
        ),
      });
    } catch (error) {
      if (error instanceof LangfuseCredentialsError) {
        return context.json({ error: error.message }, 401);
      }
      logCallbackError("Langfuse", error, {
        organizationId: tenant.organizationId,
      });
      return context.json(
        { error: "Unable to verify the Langfuse connection" },
        502,
      );
    }
  })
  .post("/custom-mcp/connect", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }

    const parsed = customMcpConnectionSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      recordCustomMcpConnectionOutcome("validation_failed");
      return context.json(
        { error: "Enter a name, a valid MCP URL, and the required authentication" },
        400,
      );
    }

    let failureOutcome: Extract<
      CustomMcpConnectionOutcome,
      "validation_failed" | "verify_failed"
    > = "validation_failed";
    let accountId: string | undefined;
    try {
      const mcpUrl = (
        await validateCustomMcpUrl(parsed.data.mcpUrl, {
          allowLocal: process.env.NODE_ENV !== "production",
        })
      ).toString();

      if (parsed.data.authType === "api_token") {
        failureOutcome = "verify_failed";
        const toolCount = await verifyCustomMcpConnection({
          accessToken: parsed.data.apiToken,
          mcpUrl,
        });
        accountId = await upsertIntegrationAccount({
          organizationId: tenant.organizationId,
          provider: "custom_mcp",
          externalAccountId: mcpUrl,
          displayName: parsed.data.displayName,
          encryptedCredentials: encryptCredentials({
            apiToken: parsed.data.apiToken,
            authType: "api_token",
            mcpUrl,
          }),
          credentialKeyVersion: 1,
          metadata: { authType: "api_token", mcpUrl, toolCount },
        });
        await captureAnalyticsEvent({
          distinctId: tenant.user.id,
          event: "integration connected",
          organizationId: tenant.organizationId,
          properties: {
            integration_account_id: accountId,
            provider: "custom_mcp",
            tool_count: toolCount,
          },
        });
        recordCustomMcpConnectionOutcome("connected");
        return context.json({
          accountId,
          redirectUrl: withIntegrationAccountId(
            settingsRedirect(
              parsed.data.returnTo ?? "/settings",
              "custom_mcp",
              "connected",
            ),
            accountId,
          ),
        });
      }

      accountId = await upsertIntegrationAccount({
        organizationId: tenant.organizationId,
        provider: "custom_mcp",
        externalAccountId: mcpUrl,
        displayName: parsed.data.displayName,
        encryptedCredentials: encryptCredentials({
          authType: "oauth",
          mcpUrl,
          oauth: {},
        }),
        credentialKeyVersion: 1,
        metadata: { authType: "oauth", mcpUrl },
        status: "pending",
      });
      const connectionState = await createIntegrationConnectionState({
        organizationId: tenant.organizationId,
        userId: tenant.user.id,
        provider: "custom_mcp",
        codeVerifier: JSON.stringify({ accountId }),
        returnTo: parsed.data.returnTo,
      });
      const oauthResult = await beginCustomMcpOAuth({
        connectionState,
        mcpUrl,
        redirectUrl: integrationCallbackUrl("custom_mcp"),
      });
      const updated = await updateIntegrationAccountCredentials({
        encryptedCredentials: encryptCredentials({
          authType: "oauth",
          mcpUrl,
          oauth: oauthResult.oauth,
        }),
        integrationAccountId: accountId,
        organizationId: tenant.organizationId,
        provider: "custom_mcp",
        status: "pending",
      });
      if (!updated) throw new Error("The custom MCP connection was not updated");
      recordCustomMcpConnectionOutcome("oauth_started");
      return context.json({ redirectUrl: oauthResult.authorizationUrl });
    } catch (error) {
      recordCustomMcpConnectionOutcome(failureOutcome);
      logCustomMcpError("connect", error, accountId);
      return context.json(
        { error: "Unable to verify or authorize the custom MCP connection" },
        502,
      );
    }
  })
  .get("/custom_mcp/callback", async (context) => {
    const state = context.req.query("state");
    if (!state) {
      return context.redirect(
        settingsRedirect("/settings", "custom_mcp", "error", "invalid_state"),
      );
    }
    let connectionState: Awaited<
      ReturnType<typeof consumeIntegrationConnectionState>
    > = null;
    let accountId: string | undefined;
    let callbackErrorLogged = false;
    try {
      connectionState = await consumeBrowserOAuthConnectionState({
        headers: context.req.raw.headers,
        provider: "custom_mcp",
        state,
      });
      if (!connectionState) {
        console.error(
          JSON.stringify({
            event: "integration_oauth_state_invalid",
            provider: "custom_mcp",
            reason: "missing_or_expired",
          }),
        );
        return context.redirect(
          settingsRedirect(
            "/settings",
            "custom_mcp",
            "error",
            "invalid_state",
          ),
        );
      }
      accountId = z
        .object({ accountId: z.uuid() })
        .parse(JSON.parse(connectionState.codeVerifier ?? "null")).accountId;
      const authorizationCode = z.string().min(1).parse(context.req.query("code"));
      const account = await getOrganizationIntegrationAccount({
        integrationAccountId: accountId,
        organizationId: connectionState.organizationId,
        provider: "custom_mcp",
      });
      if (!account?.encryptedCredentials || account.status !== "pending") {
        throw new Error("The pending custom MCP connection was not found");
      }
      const credentials = parseCustomMcpCredentials(
        decryptCredentials<Record<string, unknown>>(account.encryptedCredentials),
      );
      if (credentials.authType !== "oauth") {
        throw new Error("The custom MCP connection is not using OAuth");
      }
      const oauth = await finishCustomMcpOAuth({
        authorizationCode,
        mcpUrl: credentials.mcpUrl,
        oauth: credentials.oauth,
        redirectUrl: integrationCallbackUrl("custom_mcp"),
      });
      const accessToken = oauth.tokens?.access_token;
      if (!accessToken) throw new Error("The MCP OAuth access token is missing");
      let toolCount: number;
      try {
        toolCount = await verifyCustomMcpConnection({
          accessToken,
          mcpUrl: credentials.mcpUrl,
        });
      } catch (error) {
        logCustomMcpError("callback", error, accountId);
        callbackErrorLogged = true;
        recordCustomMcpConnectionOutcome("verify_failed");
        throw error;
      }
      const updated = await updateIntegrationAccountCredentials({
        encryptedCredentials: encryptCredentials({
          authType: "oauth",
          mcpUrl: credentials.mcpUrl,
          oauth,
        }),
        integrationAccountId: accountId,
        organizationId: connectionState.organizationId,
        provider: "custom_mcp",
        status: "connected",
      });
      if (!updated) throw new Error("The custom MCP connection was not updated");
      await captureAnalyticsEvent({
        distinctId: connectionState.userId,
        event: "integration connected",
        organizationId: connectionState.organizationId,
        properties: {
          integration_account_id: accountId,
          provider: "custom_mcp",
          tool_count: toolCount,
        },
      });
      return context.redirect(
        withIntegrationAccountId(
          settingsRedirect(
            connectionState.returnTo,
            "custom_mcp",
            "connected",
          ),
          accountId,
        ),
      );
    } catch (error) {
      if (!callbackErrorLogged) logCustomMcpError("callback", error, accountId);
      if (accountId) {
        await setIntegrationAccountStatus(accountId, "error").catch(
          (statusError: unknown) => {
            console.error(
              JSON.stringify({
                accountId,
                errorType:
                  statusError instanceof Error
                    ? statusError.name
                    : "UnknownError",
                event: "custom_mcp_status_update_failed",
              }),
            );
          },
        );
      }
      return context.redirect(
        settingsRedirect(
          connectionState?.returnTo ?? "/settings",
          "custom_mcp",
          "error",
          context.req.query("error") ? "cancelled" : "connection_failed",
        ),
      );
    }
  })
  .get("/linear/callback", async (context) => {
    const state = context.req.query("state");
    if (!state) {
      return context.redirect(
        settingsRedirect("/settings", "linear", "error", "invalid_state"),
      );
    }

    const connectionState = await consumeBrowserOAuthConnectionState({
      headers: context.req.raw.headers,
      provider: "linear",
      state,
    });
    if (!connectionState) {
      return context.redirect(
        settingsRedirect("/settings", "linear", "error", "invalid_state"),
      );
    }

    let accountId: string | undefined;
    try {
      const codeVerifier = z.string().min(1).parse(connectionState.codeVerifier);
      const authorizationCode = z.string().min(1).parse(context.req.query("code"));
      const credentials = await exchangeLinearOAuthCode({
        authorizationCode,
        codeVerifier,
        redirectUri: integrationCallbackUrl("linear"),
      });
      const workspace = await getLinearWorkspace({
        accessToken: credentials.accessToken,
      });
      const toolCount = await verifyCustomMcpConnection({
        accessToken: credentials.accessToken,
        mcpUrl: LINEAR_READONLY_MCP_URL,
      });
      const connectedAccountId = await upsertIntegrationAccount({
        organizationId: connectionState.organizationId,
        provider: "linear",
        // A workspace is the external account. Keying every connection by the
        // shared MCP URL would overwrite credentials in-place and silently
        // redirect existing immutable agent versions to another workspace.
        externalAccountId: workspace.id,
        displayName: workspace.name,
        encryptedCredentials: encryptCredentials(credentials),
        credentialKeyVersion: 1,
        metadata: {
          authType: "linear_oauth",
          authVersion: LINEAR_AUTH_VERSION,
          mcpUrl: LINEAR_MCP_URL,
          toolCount,
          workspaceId: workspace.id,
        },
        status: "connected",
      });
      accountId = connectedAccountId;
      await captureAnalyticsEvent({
        distinctId: connectionState.userId,
        event: "integration connected",
        organizationId: connectionState.organizationId,
        properties: {
          integration_account_id: accountId,
          provider: "linear",
          tool_count: toolCount,
        },
      });
      return context.redirect(
        withIntegrationAccountId(
          settingsRedirect(connectionState.returnTo, "linear", "connected"),
          accountId,
        ),
      );
    } catch (error) {
      logCustomMcpError("callback", error, accountId);
      return context.redirect(
        settingsRedirect(
          connectionState.returnTo,
          "linear",
          "error",
          context.req.query("error") ? "cancelled" : "connection_failed",
        ),
      );
    }
  })
  .post("/clickstack/connect", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }

    const parsed = clickStackConnectionSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return context.json(
        { error: "Choose ClickStack Cloud or enter self-hosted credentials" },
        400,
      );
    }

    try {
      if (parsed.data.deployment === "cloud") {
        const redirectUri = integrationCallbackUrl("clickstack");
        const clientId = await registerClickStackCloudClient(redirectUri);
        const pkce = createClickStackPkce();
        const state = await createIntegrationConnectionState({
          organizationId: tenant.organizationId,
          userId: tenant.user.id,
          provider: "clickstack",
          codeVerifier: pkce.codeVerifier,
          metadata: {
            clientId,
            serviceId: parsed.data.serviceId,
          },
          returnTo: parsed.data.returnTo,
          routingUrl: redirectUri,
        });
        return context.json({
          redirectUrl: clickStackCloudAuthorizeUrl({
            clientId,
            codeChallenge: pkce.codeChallenge,
            redirectUri,
            state,
          }),
        });
      }

      const account = await clickStackAccount(parsed.data);
      const accountId = await upsertIntegrationAccount({
        organizationId: tenant.organizationId,
        provider: "clickstack",
        externalAccountId: account.externalAccountId,
        displayName: account.displayName,
        encryptedCredentials: encryptCredentials({
          authType: "access_key",
          accessKey: parsed.data.accessKey,
          mcpUrl: account.mcpUrl,
        }),
        credentialKeyVersion: 1,
        metadata: {
          deployment: "self_hosted",
          mcpUrl: account.mcpUrl,
          teamId: account.teamId,
        },
      });
      await captureAnalyticsEvent({
        distinctId: tenant.user.id,
        event: "integration connected",
        organizationId: tenant.organizationId,
        properties: {
          integration_account_id: accountId,
          provider: "clickstack",
        },
      });
      console.info(
        JSON.stringify({
          accountId,
          deployment: "self_hosted",
          event: "clickstack_connected",
          organizationId: tenant.organizationId,
          provider: "clickstack",
        }),
      );
      return context.json({
        accountId,
        redirectUrl: settingsRedirect(
          parsed.data.returnTo ?? "/settings",
          "clickstack",
          "connected",
        ),
      });
    } catch (error) {
      if (error instanceof ClickStackCredentialsError) {
        logClickStackConnectError(
          error,
          tenant.organizationId,
          parsed.data.deployment,
        );
        return context.json({ error: error.message }, 401);
      }
      if (error instanceof ClickStackOAuthError) {
        logClickStackConnectError(
          error,
          tenant.organizationId,
          parsed.data.deployment,
        );
        return context.json({ error: error.message }, 502);
      }
      logCallbackError("ClickStack", error, {
        deployment: parsed.data.deployment,
        organizationId: tenant.organizationId,
      });
      return context.json(
        { error: "Unable to verify the ClickStack connection" },
        502,
      );
    }
  })
  .get("/clickstack/callback", async (context) => {
    const state = context.req.query("state");
    const code = context.req.query("code");
    const oauthError = context.req.query("error");
    if (!state) {
      return context.redirect(
        settingsRedirect("/settings", "clickstack", "error", "invalid_state"),
      );
    }

    const connectionState = await consumeBrowserOAuthConnectionState({
      headers: context.req.raw.headers,
      provider: "clickstack",
      state,
    });
    if (!connectionState) {
      return context.redirect(
        settingsRedirect("/settings", "clickstack", "error", "invalid_state"),
      );
    }
    if (oauthError || !code || !connectionState.codeVerifier) {
      if (oauthError) {
        console.info(
          JSON.stringify({
            event: "clickstack_oauth_denied",
            oauthError,
            organizationId: connectionState.organizationId,
            provider: "clickstack",
          }),
        );
      } else {
        console.info(
          JSON.stringify({
            event: "clickstack_callback_incomplete",
            organizationId: connectionState.organizationId,
            provider: "clickstack",
            reason: !code ? "missing_code" : "missing_code_verifier",
          }),
        );
      }
      return context.redirect(
        settingsRedirect(
          connectionState.returnTo,
          "clickstack",
          "error",
          oauthError ? "access_denied" : "missing_code",
        ),
      );
    }

    const metadata = z
      .object({ clientId: z.string().min(1), serviceId: z.uuid() })
      .safeParse(connectionState.metadata);
    if (!metadata.success) {
      console.error(
        JSON.stringify({
          deployment: "cloud",
          error: "invalid_callback_metadata",
          event: "clickstack_callback_invalid_metadata",
          organizationId: connectionState.organizationId,
          provider: "clickstack",
        }),
      );
      return context.redirect(
        settingsRedirect(
          connectionState.returnTo,
          "clickstack",
          "error",
          "invalid_state",
        ),
      );
    }

    try {
      const token = await exchangeClickStackCloudCode({
        clientId: metadata.data.clientId,
        code,
        codeVerifier: connectionState.codeVerifier,
        redirectUri: integrationCallbackUrl("clickstack"),
      });
      const accountId = await upsertIntegrationAccount({
        organizationId: connectionState.organizationId,
        provider: "clickstack",
        externalAccountId: metadata.data.serviceId,
        displayName: `ClickStack Cloud · ${metadata.data.serviceId.slice(0, 8)}`,
        encryptedCredentials: encryptCredentials({
          authType: "oauth",
          accessToken: token.access_token,
          clientId: metadata.data.clientId,
          expiresAt: Date.now() + token.expires_in * 1_000,
          mcpUrl: CLICKSTACK_CLOUD_MCP_URL,
          refreshToken: token.refresh_token,
          scope: token.scope,
          serviceId: metadata.data.serviceId,
          tokenType: token.token_type,
        }),
        credentialKeyVersion: 1,
        metadata: {
          deployment: "cloud",
          mcpUrl: CLICKSTACK_CLOUD_MCP_URL,
          serviceId: metadata.data.serviceId,
        },
      });
      await captureAnalyticsEvent({
        distinctId: connectionState.userId,
        event: "integration connected",
        organizationId: connectionState.organizationId,
        properties: {
          integration_account_id: accountId,
          provider: "clickstack",
        },
      });
      console.info(
        JSON.stringify({
          accountId,
          deployment: "cloud",
          event: "clickstack_connected",
          organizationId: connectionState.organizationId,
          provider: "clickstack",
        }),
      );
      return context.redirect(
        settingsRedirect(
          connectionState.returnTo,
          "clickstack",
          "connected",
        ),
      );
    } catch (error) {
      logCallbackError("ClickStack", error, {
        deployment: "cloud",
        organizationId: connectionState.organizationId,
        returnTo: connectionState.returnTo,
      });
      return context.redirect(
        settingsRedirect(
          connectionState.returnTo,
          "clickstack",
          "error",
          "connection_failed",
        ),
      );
    }
  })
  .get("/vercel/callback", async (context) => {
    const state = context.req.query("state");
    if (!state) {
      return context.redirect(
        settingsRedirect("/settings", "vercel", "error", "invalid_state"),
      );
    }
    const connectionState = await consumeBrowserOAuthConnectionState({
      headers: context.req.raw.headers,
      provider: "vercel",
      state,
    });
    if (!connectionState) {
      return context.redirect(
        settingsRedirect("/settings", "vercel", "error", "invalid_state"),
      );
    }
    if (context.req.query("error")) {
      return context.redirect(
        settingsRedirect(
          connectionState.returnTo,
          "vercel",
          "error",
          "cancelled",
        ),
      );
    }
    const callback = vercelCallbackSchema.safeParse({
      code: context.req.query("code"),
      configurationId: context.req.query("configurationId"),
      teamId: context.req.query("teamId"),
    });
    if (!callback.success) {
      return context.redirect(
        settingsRedirect(
          connectionState.returnTo,
          "vercel",
          "error",
          "invalid_callback",
        ),
      );
    }

    try {
      const token = await exchangeVercelCode({
        code: callback.data.code,
        redirectUri: integrationCallbackUrl("vercel"),
      });
      const teamId = token.team_id ?? null;
      if (teamId !== (callback.data.teamId ?? null)) {
        throw new Error("The Vercel callback team did not match the token");
      }
      const configuration = await getVercelConfiguration({
        accessToken: token.access_token,
        configurationId: callback.data.configurationId,
        teamId,
      });
      const account = await getVercelAccount({
        accessToken: token.access_token,
        teamId,
        userId: token.user_id,
      });
      let projects = await listVercelProjects({
        accessToken: token.access_token,
        teamId,
      });
      if (configuration.projectSelection === "selected") {
        const selectedProjectIds = new Set(configuration.projects);
        projects = projects.filter((project) =>
          selectedProjectIds.has(project.externalId),
        );
        if (
          new Set(projects.map((project) => project.externalId)).size !==
          selectedProjectIds.size
        ) {
          throw new Error("The Vercel selected-project set could not be verified");
        }
      }
      const accountId = await upsertIntegrationAccount({
        organizationId: connectionState.organizationId,
        provider: "vercel",
        externalAccountId: callback.data.configurationId,
        displayName: account.displayName,
        encryptedCredentials: encryptCredentials({
          accessToken: token.access_token,
          configurationId: callback.data.configurationId,
          teamId,
          userId: token.user_id ?? null,
        }),
        credentialKeyVersion: 1,
        metadata: {
          ...account.metadata,
          configurationId: callback.data.configurationId,
          projectSelection: configuration.projectSelection,
          scopes: configuration.scopes,
          scopeExternalAccountId: account.externalAccountId,
        },
      });
      await replaceIntegrationResources(accountId, "vercel_project", projects);
      await captureAnalyticsEvent({
        distinctId: connectionState.userId,
        event: "integration connected",
        organizationId: connectionState.organizationId,
        properties: {
          integration_account_id: accountId,
          provider: "vercel",
          resource_count: projects.length,
        },
      });
      return context.redirect(
        withIntegrationAccountId(
          settingsRedirect(connectionState.returnTo, "vercel", "connected"),
          accountId,
        ),
      );
    } catch (error) {
      logCallbackError("Vercel", error, {
        configurationId: callback.data.configurationId,
        organizationId: connectionState.organizationId,
      });
      return context.redirect(
        settingsRedirect(
          connectionState.returnTo,
          "vercel",
          "error",
          callbackErrorReason(error),
        ),
      );
    }
  })
  .get("/sentry/callback", async (context) => {
    const state = context.req.query("state");
    if (!state) {
      return context.redirect(
        settingsRedirect("/settings", "sentry", "error", "invalid_state"),
      );
    }

    const callback = {
      code: context.req.query("code"),
      installationId: context.req.query("installationId"),
      orgSlug: context.req.query("orgSlug"),
    };
    const parsedCompletion = z
      .object({
        installationId: z.uuid(),
        orgSlug: z.string().min(1),
      })
      .safeParse(callback);

    // With install verification enabled, Sentry follows the authorization
    // callback with a browser redirect that repeats the installation details
    // but omits the one-time code. The coded callback owns state consumption;
    // this follow-up only needs to land the user back in Responder.
    if (
      !callback.code &&
      parsedCompletion.success &&
      state.startsWith("responder-v1.")
    ) {
      return context.redirect(
        settingsRedirect("/settings", "sentry", "finishing"),
      );
    }

    const connectionState = await consumeBrowserOAuthConnectionState({
      headers: context.req.raw.headers,
      provider: "sentry",
      state,
    });
    if (!connectionState) {
      return context.redirect(
        settingsRedirect("/settings", "sentry", "error", "invalid_state"),
      );
    }

    const parsedCallback = z
      .object({
        code: z.string().min(1),
        installationId: z.uuid(),
        orgSlug: z.string().min(1),
      })
      .safeParse({
        code: callback.code,
        installationId: callback.installationId,
        orgSlug: callback.orgSlug,
      });
    if (!parsedCallback.success) {
      return context.redirect(
        settingsRedirect(
          connectionState.returnTo,
          "sentry",
          "error",
          "invalid_callback",
        ),
      );
    }

    let accountId: string | null = null;
    try {
      accountId = await upsertIntegrationAccount({
        organizationId: connectionState.organizationId,
        provider: "sentry",
        externalAccountId: parsedCallback.data.installationId,
        displayName: parsedCallback.data.orgSlug,
        status: "pending",
        encryptedCredentials: null,
        credentialKeyVersion: null,
        metadata: {
          installationId: parsedCallback.data.installationId,
          organizationSlug: parsedCallback.data.orgSlug,
        },
      });
      const authorization = await exchangeSentryGrant(parsedCallback.data);
      accountId = await upsertIntegrationAccount({
        organizationId: connectionState.organizationId,
        provider: "sentry",
        externalAccountId: parsedCallback.data.installationId,
        displayName: parsedCallback.data.orgSlug,
        status: "pending",
        encryptedCredentials: encryptCredentials({
          accessToken: authorization.token,
          refreshToken: authorization.refreshToken,
          expiresAt: authorization.expiresAt ?? null,
          installationId: parsedCallback.data.installationId,
        }),
        credentialKeyVersion: 1,
        metadata: {
          installationId: parsedCallback.data.installationId,
          organizationSlug: parsedCallback.data.orgSlug,
        },
      });
      const resourceCount = await completeSentrySetup({
        accessToken: authorization.token,
        accountId,
        installationId: parsedCallback.data.installationId,
        organizationSlug: parsedCallback.data.orgSlug,
      });
      await captureAnalyticsEvent({
        distinctId: connectionState.userId,
        event: "integration connected",
        organizationId: connectionState.organizationId,
        properties: {
          integration_account_id: accountId,
          provider: "sentry",
          resource_count: resourceCount,
        },
      });

      return context.redirect(
        settingsRedirect(connectionState.returnTo, "sentry", "connected"),
      );
    } catch (error) {
      if (accountId) {
        await setIntegrationAccountStatus(accountId, "error").catch(
          (statusError: unknown) => {
            logCallbackError("Sentry status update", statusError);
          },
        );
      }
      logCallbackError("Sentry", error);
      return context.redirect(
        settingsRedirect(
          connectionState.returnTo,
          "sentry",
          "error",
          callbackErrorReason(error),
        ),
      );
    }
  })
  .get("/slack/callback", async (context) => {
    const state = context.req.query("state");
    if (!state) {
      return context.redirect(
        settingsRedirect("/settings", "slack", "error", "invalid_state"),
      );
    }

    const connectionState = await consumeBrowserOAuthConnectionState({
      headers: context.req.raw.headers,
      provider: "slack",
      state,
    });
    if (!connectionState) {
      return context.redirect(
        settingsRedirect("/settings", "slack", "error", "invalid_state"),
      );
    }
    if (context.req.query("error")) {
      return context.redirect(
        settingsRedirect(connectionState.returnTo, "slack", "error", "cancelled"),
      );
    }

    const code = context.req.query("code");
    if (!code) {
      return context.redirect(
        settingsRedirect(
          connectionState.returnTo,
          "slack",
          "error",
          "missing_code",
        ),
      );
    }

    try {
      const installation = await exchangeSlackCode(code);
      const encryptedCredentials = encryptCredentials({
        accessToken: installation.access_token,
        tokenType: installation.token_type,
        userAccessToken: installation.authed_user.access_token,
        userTokenType: installation.authed_user.token_type,
      });
      const accountId = await upsertIntegrationAccount({
        organizationId: connectionState.organizationId,
        provider: "slack",
        externalAccountId: installation.team.id,
        displayName: installation.team.name,
        encryptedCredentials,
        credentialKeyVersion: 1,
        metadata: {
          appId: installation.app_id,
          botUserId: installation.bot_user_id,
          connectedBySlackUserId: installation.authed_user.id,
          enterpriseId: installation.enterprise?.id ?? null,
          scopes: installation.scope.split(",").filter(Boolean),
          userScopes: installation.authed_user.scope.split(",").filter(Boolean),
        },
      });
      const channels = await listSlackChannels(installation.access_token);
      await replaceIntegrationResources(accountId, "slack_channel", channels);
      await captureAnalyticsEvent({
        distinctId: connectionState.userId,
        event: "integration connected",
        organizationId: connectionState.organizationId,
        properties: {
          integration_account_id: accountId,
          provider: "slack",
          resource_count: channels.length,
        },
      });

      return context.redirect(
        settingsRedirect(connectionState.returnTo, "slack", "connected"),
      );
    } catch (error) {
      logCallbackError("Slack", error);
      return context.redirect(
        settingsRedirect(
          connectionState.returnTo,
          "slack",
          "error",
          callbackErrorReason(error),
        ),
      );
    }
  })
  .get("/github/callback", async (context) => {
    const state = context.req.query("state");
    if (!state) {
      return context.redirect(
        settingsRedirect("/settings", "github", "error", "invalid_state"),
      );
    }

    const connectionState = await consumeBrowserOAuthConnectionState({
      headers: context.req.raw.headers,
      provider: "github",
      state,
    });
    if (!connectionState) {
      return context.redirect(
        settingsRedirect("/settings", "github", "error", "invalid_state"),
      );
    }
    if (context.req.query("error")) {
      return context.redirect(
        settingsRedirect(connectionState.returnTo, "github", "error", "cancelled"),
      );
    }

    const parsedCallback = z
      .object({
        code: z.string().min(1),
        installationId: z.coerce.number().int().positive().optional(),
      })
      .safeParse({
        code: context.req.query("code"),
        installationId: context.req.query("installation_id"),
      });
    if (!parsedCallback.success) {
      return context.redirect(
        settingsRedirect(
          connectionState.returnTo,
          "github",
          "error",
          "invalid_callback",
        ),
      );
    }

    try {
      const userToken = await exchangeGitHubCode(
        parsedCallback.data.code,
        context.req.query("setup_action")
          ? ""
          : integrationCallbackUrl("github"),
      );
      const installations = parsedCallback.data.installationId
        ? [
            await verifyGitHubUserInstallation(
              userToken.access_token,
              parsedCallback.data.installationId,
            ),
          ]
        : await listGitHubUserInstallations(userToken.access_token);
      if (installations.length === 0) {
        throw new Error("No GitHub App installations are available to this user");
      }

      const connectedAccounts: Array<{
        accountId: string;
        repositoryCount: number;
      }> = [];
      for (const installation of installations) {
        const accountId = await upsertIntegrationAccount({
          organizationId: connectionState.organizationId,
          provider: "github",
          externalAccountId: String(installation.id),
          displayName: installation.account.login,
          metadata: {
            accountId: installation.account.id,
            accountType: installation.account.type,
            repositorySelection: installation.repository_selection,
          },
        });
        const repositories = await listGitHubRepositories(installation.id);
        await replaceRepositories(accountId, repositories);
        connectedAccounts.push({
          accountId,
          repositoryCount: repositories.length,
        });
      }

      const disabledAgents = await disableAgentsWithUnavailableRepositories(
        connectionState.organizationId,
      );

      await Promise.all(
        connectedAccounts.map((account) =>
          captureAnalyticsEvent({
            distinctId: connectionState.userId,
            event: "integration connected",
            organizationId: connectionState.organizationId,
            properties: {
              integration_account_id: account.accountId,
              provider: "github",
              resource_count: account.repositoryCount,
            },
          }),
        ),
      );

      const redirectUrl = new URL(
        settingsRedirect(connectionState.returnTo, "github", "connected"),
      );
      if (disabledAgents.length > 0) {
        redirectUrl.searchParams.set(
          "disabled_agents",
          String(disabledAgents.length),
        );
      }
      return context.redirect(redirectUrl.toString());
    } catch (error) {
      logCallbackError("GitHub", error);
      return context.redirect(
        settingsRedirect(
          connectionState.returnTo,
          "github",
          "error",
          callbackErrorReason(error),
        ),
      );
    }
  });
