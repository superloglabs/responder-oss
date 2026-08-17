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
  getOrganizationIntegrationAccount,
  getRecoverableSentryIntegrationAccount,
  listOrganizationIntegrationAccounts,
  replaceIntegrationResources,
  replaceRepositories,
  setIntegrationAccountStatus,
  updateIntegrationAccountCredentials,
  upsertIntegrationAccount,
} from "../../../../packages/core/src/db/integrations.js";
import { disableAgentsWithUnavailableRepositories } from "../../../../packages/core/src/db/agents.js";
import {
  beginCustomMcpOAuth,
  finishCustomMcpOAuth,
  parseCustomMcpCredentials,
  validateCustomMcpUrl,
  verifyCustomMcpConnection,
} from "../../../../packages/core/src/integrations/custom-mcp.js";
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
  exchangeSentryGrant,
  listSentryProjects,
  sentryInstallUrl,
  verifySentryInstallation,
} from "./sentry.js";
import {
  upstashAccount,
  UpstashCredentialsError,
} from "./upstash.js";
import { integrationCallbackUrl, settingsRedirect } from "./urls.js";

const providerSchema = z.enum(productIntegrationIds);
const sentryCredentialsSchema = z.object({
  accessToken: z.string().min(1),
  installationId: z.uuid(),
});
const datadogConnectionSchema = z.object({
  apiKey: z.string().trim().min(1).max(512),
  applicationKey: z.string().trim().min(1).max(512),
  returnTo: z.string().max(2_048).optional(),
  site: z.string().min(1),
});
const upstashConnectionSchema = z.object({
  apiKey: z.string().trim().min(1).max(4_096),
  email: z.string().trim().email().max(320),
  returnTo: z.string().max(2_048).optional(),
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
  if (context) {
    console.error(
      JSON.stringify({
        ...context,
        error: message,
        event: "integration_callback_failed",
        provider: provider.toLowerCase(),
      }),
    );
  } else {
    console.error(
      JSON.stringify({
        error: message,
        event: "integration_callback_failed",
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
  stage: "callback" | "connect",
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
  installationId: string;
  organizationSlug: string;
}): Promise<number> {
  const projects = await listSentryProjects(
    input.accessToken,
    input.organizationSlug,
  );
  await replaceIntegrationResources(input.accountId, "sentry_project", projects);
  await verifySentryInstallation(input.accessToken, input.installationId);
  await setIntegrationAccountStatus(input.accountId, "connected");
  return projects.length;
}

async function retrySentrySetup(organizationId: string): Promise<{
  accountId: string;
  resourceCount: number;
} | null> {
  const account = await getRecoverableSentryIntegrationAccount(organizationId);
  if (!account?.encryptedCredentials) return null;
  const credentials = sentryCredentialsSchema.parse(
    decryptCredentials<Record<string, unknown>>(account.encryptedCredentials),
  );
  const organizationSlug = z
    .string()
    .min(1)
    .parse(account.metadata.organizationSlug);
  try {
    const resourceCount = await completeSentrySetup({
      accessToken: credentials.accessToken,
      accountId: account.id,
      installationId: credentials.installationId,
      organizationSlug,
    });
    return { accountId: account.id, resourceCount };
  } catch (error) {
    await setIntegrationAccountStatus(account.id, "error");
    throw error;
  }
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
          (account) => account.status === "connected",
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
            status: account.status,
            resourceCount: account.resourceCount,
            updatedAt: account.updatedAt,
          })),
          connectUrl:
            definition.implemented && configured
              ? definition.id === "datadog" ||
                  definition.id === "clickstack" ||
                  definition.id === "upstash"
                ? `/api/integrations/${definition.id}/connect`
                : definition.id === "custom_mcp"
                  ? "/api/integrations/custom-mcp/connect"
                : definition.id === "github" && providerAccounts.length === 0
                  ? "/api/integrations/github/start?mode=install"
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
      parsedProvider.data === "datadog" ||
      parsedProvider.data === "clickstack" ||
      parsedProvider.data === "upstash"
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
        return context.redirect(
          settingsRedirect(
            context.req.query("returnTo") ?? "/settings",
            "sentry",
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
        parsedProvider.data === "github" || parsedProvider.data === "sentry"
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

    return context.json({ error: "Integration is not available yet" }, 501);
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
      connectionState = await consumeIntegrationConnectionState(
        "custom_mcp",
        state,
      );
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

    const connectionState = await consumeIntegrationConnectionState(
      "clickstack",
      state,
    );
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

    const connectionState = await consumeIntegrationConnectionState(
      "sentry",
      state,
    );
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

    const connectionState = await consumeIntegrationConnectionState("slack", state);
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

    const connectionState = await consumeIntegrationConnectionState("github", state);
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
