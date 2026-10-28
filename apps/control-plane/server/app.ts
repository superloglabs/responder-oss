import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as Sentry from "@sentry/hono/node";
import { createHash } from "node:crypto";
import { verifyBearerToken } from "../../../packages/core/src/auth/internal.js";
import { cellDirectory } from "../../../packages/core/src/cells.js";
import {
  hasWebhookTenant,
  webhookTenantSchema,
  webhookTenantState,
} from "../../../packages/core/src/db/webhook-tenants.js";
import { cellCallbackRouter } from "./cells/callback-router.js";
import { legacyWebhookForwarder } from "./cells/legacy-webhook-forwarder.js";
import { cellWebhookRouter } from "./cells/webhook-router.js";
import { getAuthUserSupportIdentity } from "../../../packages/core/src/db/superusers.js";
import { investigationRequestSchema } from "../../../packages/core/src/investigations/input.js";
import { agentRoutes } from "./agents/routes.js";
import {
  authHandlerErrorMessage,
  canImpersonateSupportUser,
  configuredSuperuserEmails,
  getAuth,
  platformRoleForIdentity,
} from "./auth.js";
import {
  clearLegacyAccountRedirect,
  legacyProductUrl,
  shouldRedirectLegacyAccount,
} from "../../../packages/core/src/db/legacy-account-redirect.js";
import { billingRoutes } from "./billing/routes.js";
import { consentBasePath, handleConsentRequest } from "./consent.js";
import { smsConsentRoutes } from "./sms-consent.js";
import { integrationRoutes } from "./integrations/routes.js";
import { issueRoutes } from "./issues/routes.js";
import { createSyntheticRoutes } from "./synthetics/routes.js";
import { createAlertRoutes } from "./telemetry/alert-routes.js";
import { createErrorIssueRoutes } from "./telemetry/error-issue-routes.js";
import { createDashboardRoutes } from "./telemetry/dashboard-routes.js";
import { createIngestKeyRoutes } from "./telemetry/ingest-key-routes.js";
import { createIngestRoutes } from "./telemetry/ingest-routes.js";
import { createBrowserRelayRoutes } from "./telemetry/browser-relay-routes.js";
import { createSourceRoutes } from "./telemetry/source-routes.js";
import { createTelemetryRoutes } from "./telemetry/routes.js";
import { queueInvestigation } from "./investigations/queue.js";
import { getActiveTenant } from "./tenant.js";
import { githubWebhookRoutes } from "./webhooks/github.js";
import { sentryWebhookRoutes } from "./webhooks/sentry.js";
import { axiomWebhookRoutes } from "./webhooks/axiom.js";
import { devrevWebhookRoutes } from "./webhooks/devrev.js";
import { signozWebhookRoutes } from "./webhooks/signoz.js";
import { honeycombWebhookRoutes } from "./webhooks/honeycomb.js";
import { betterStackWebhookRoutes } from "./webhooks/betterstack.js";
import { dash0WebhookRoutes } from "./webhooks/dash0.js";
import { slackWebhookRoutes } from "./webhooks/slack.js";
import { discordWebhookRoutes } from "./webhooks/discord.js";
import { linearWebhookRoutes } from "./webhooks/linear.js";
import { automationWebhookRoutes } from "./webhooks/automations.js";
import { pullRequestRoutes } from "./pull-requests/routes.js";
import { scanRoutes } from "./scans/routes.js";
import { suggestionRoutes } from "./suggestions/routes.js";
import { automationModelBrokerRoutes } from "./automations/model-broker.js";
import { automationRoutes } from "./automations/routes.js";
import { sharedAutomationTemplateRoutes } from "./automations/shared-templates.js";
import { createAutomationContextBrokerRoutes } from "./automations/context-broker.js";
import { listEnabledOrganizationCapabilities } from "../../../packages/core/src/db/organization-capabilities.js";
import { apiKeyRoutes } from "./management/api-key-routes.js";
import { terraformRoutes } from "./terraform/routes.js";
import { skillRoutes } from "./skills/routes.js";
import { managementMcpRoutes } from "./management/mcp.js";
import { managementApiRoutes } from "./management/routes.js";
import { oauthMetadataRoutes } from "./oauth-metadata-routes.js";
import { requestMetrics } from "./request-metrics.js";

const sessionCookiePattern =
  /(?:^|[;,]\s*)(?:__Secure-)?(?:better-auth|responder-auth)\.session_token=/;

export const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
// GitHub accepts webhook deliveries up to 25 MiB. Keep signed provider
// callbacks compatible while retaining a finite in-process buffering bound.
export const MAX_WEBHOOK_REQUEST_BODY_BYTES = 25 * 1024 * 1024;
// A skill is saved whole, with up to 3 MiB of reference files.
export const MAX_SKILL_REQUEST_BODY_BYTES = 4 * 1024 * 1024;
// OTLP batches from applications, which may be uncompressed JSON.
export const MAX_TELEMETRY_INGEST_BODY_BYTES = 8 * 1024 * 1024;

export function sessionCookieFingerprint(cookieHeader: string): string {
  const match =
    /(?:^|;\s*)(?:__Secure-)?(?:better-auth|responder-auth)\.session_token=([^;]+)/.exec(
      cookieHeader,
    );
  if (!match?.[1]) return "unknown";
  return createHash("sha256").update(match[1]).digest("hex").slice(0, 12);
}

export { authHandlerErrorMessage };

export function logAuthCallback(
  provider: string,
  status: number,
  setsSessionCookie: boolean,
) {
  const log = status >= 400 ? console.error : console.info;
  log(
    JSON.stringify({
      event: "auth_callback",
      provider,
      status,
      setsSessionCookie,
    }),
  );
}

async function handleAuthRequest(request: Request): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  const requiresSuperuser =
    pathname.includes("/admin/") &&
    !pathname.endsWith("/admin/stop-impersonating");
  const impersonationAction = pathname.endsWith("/admin/impersonate-user")
    ? "start"
    : pathname.endsWith("/admin/stop-impersonating")
      ? "stop"
      : null;
  const targetUserId =
    impersonationAction === "start"
      ? await request
          .clone()
          .json()
          .then((body: unknown) => {
            if (!body || typeof body !== "object" || !("userId" in body)) {
              return null;
            }
            return typeof body.userId === "string" ? body.userId : null;
          })
          .catch(() => null)
      : null;
  const auth = getAuth();
  const sessionBefore = impersonationAction || requiresSuperuser
    ? await auth.api.getSession({ headers: request.headers }).catch(() => null)
    : null;
  if (
    requiresSuperuser &&
    (!sessionBefore ||
      platformRoleForIdentity(
        sessionBefore.user,
        configuredSuperuserEmails(),
      ) !== "superuser")
  ) {
    console.info(
      JSON.stringify({
        event: "superuser_access_denied",
        actorUserId: sessionBefore?.user.id ?? null,
        pathname,
        requestId: request.headers.get("x-request-id") ?? "unknown",
      }),
    );
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  if (impersonationAction === "start" && !targetUserId) {
    console.info(
      JSON.stringify({
        event: "impersonation_start",
        outcome: "failure",
        actorUserId: sessionBefore?.user.id ?? null,
        targetUserId: null,
        status: 400,
        reason: "missing_target_user_id",
        requestId: request.headers.get("x-request-id") ?? "unknown",
      }),
    );
    return Response.json(
      { error: "Invalid impersonation target" },
      { status: 400 },
    );
  }
  if (impersonationAction === "start" && targetUserId) {
    const target = await getAuthUserSupportIdentity(targetUserId);
    if (!canImpersonateSupportUser(target, configuredSuperuserEmails())) {
      console.info(
        JSON.stringify({
          event: "impersonation_start",
          outcome: "failure",
          actorUserId: sessionBefore?.user.id ?? null,
          targetUserId,
          status: 403,
          requestId: request.headers.get("x-request-id") ?? "unknown",
        }),
      );
      return Response.json({ error: "User cannot be impersonated" }, { status: 403 });
    }
  }
  let response: Response;
  try {
    response = await auth.handler(request);
  } catch (handlerError) {
    console.error(
      JSON.stringify({
        event: "auth_handler_error",
        pathname,
        errorCode:
          handlerError instanceof Error
            ? handlerError.constructor.name
            : "unknown",
        errorMessage: authHandlerErrorMessage(handlerError),
      }),
    );
    throw handlerError;
  }

  if (impersonationAction) {
    console.info(
      JSON.stringify({
        event: `impersonation_${impersonationAction}`,
        outcome: response.ok ? "success" : "failure",
        actorUserId:
          impersonationAction === "start"
            ? sessionBefore?.user.id ?? null
            : sessionBefore?.session.impersonatedBy ?? null,
        targetUserId:
          impersonationAction === "stop"
            ? sessionBefore?.user.id ?? null
            : targetUserId,
        status: response.status,
        requestId: request.headers.get("x-request-id") ?? "unknown",
      }),
    );
  }

  if (pathname.startsWith("/api/auth/callback/")) {
    const setCookie = response.headers.get("set-cookie") ?? "";
    logAuthCallback(
      pathname.split("/").at(-1) ?? "unknown",
      response.status,
      sessionCookiePattern.test(setCookie),
    );
  } else if (pathname === "/api/auth/get-session") {
    const hasSessionCookie = sessionCookiePattern.test(
      request.headers.get("cookie") ?? "",
    );
    const payload = await response
      .clone()
      .json()
      .then((body: unknown) => body as { session?: unknown } | null)
      .catch((parseError: unknown) => {
        console.info(
          JSON.stringify({
            event: "auth_get_session_parse_failed",
            pathname,
            errorCode:
              parseError instanceof Error
                ? parseError.constructor.name
                : "unknown",
          }),
        );
        return undefined;
      });
    if (payload !== undefined && hasSessionCookie && !payload?.session) {
      console.error(
        JSON.stringify({
          event: "auth_session_missing_despite_cookie",
          pathname,
          hasSessionCookie: true,
          hasSession: false,
          sessionFingerprint: sessionCookieFingerprint(
            request.headers.get("cookie") ?? "",
          ),
          requestId:
            request.headers.get("x-request-id") ?? "unknown",
        }),
      );
    }
  }

  return response;
}

const instrumentedApp = new Hono();
function requestBodyLimit(maxSize: number) {
  return bodyLimit({
    maxSize,
    onError: (context) => {
      console.warn(
        JSON.stringify({
          contentLength: context.req.header("content-length") ?? null,
          event: "request_body_too_large",
          maxBytes: maxSize,
          pathname: context.req.path,
        }),
      );
      return context.json({ error: "Request body too large" }, 413);
    },
  });
}

const apiBodyLimit = requestBodyLimit(MAX_REQUEST_BODY_BYTES);
const githubWebhookBodyLimit = requestBodyLimit(
  MAX_WEBHOOK_REQUEST_BODY_BYTES,
);
const skillBodyLimit = requestBodyLimit(MAX_SKILL_REQUEST_BODY_BYTES);
const telemetryIngestBodyLimit = requestBodyLimit(MAX_TELEMETRY_INGEST_BODY_BYTES);
const githubWebhookPaths = new Set([
  "/api/webhooks/github",
  "/api/webhooks/github/",
]);
instrumentedApp.use("*", (context, next) =>
  githubWebhookPaths.has(context.req.path)
    ? githubWebhookBodyLimit(context, next)
    : context.req.path === "/api/skills" || context.req.path.startsWith("/api/skills/")
      ? skillBodyLimit(context, next)
      : context.req.path.startsWith("/api/ingest/")
        ? telemetryIngestBodyLimit(context, next)
        : apiBodyLimit(context, next),
);
if (Sentry.isInitialized()) {
  instrumentedApp.use(Sentry.sentry(instrumentedApp));
  instrumentedApp.use(async (_context, next) => {
    Sentry.setTag("service", "responder-control-plane");
    await next();
  });
}
instrumentedApp.use("/api/*", requestMetrics());
// After the body limits and monitoring, before the webhook and OAuth callback
// handlers.
instrumentedApp.use("/api/webhooks/*", legacyWebhookForwarder());
instrumentedApp.use("/api/webhooks/*", cellWebhookRouter());
instrumentedApp.use("/api/integrations/:provider/callback", cellCallbackRouter());

export const app = instrumentedApp
  .get("/api/health", (context) =>
    context.json({
      service: "responder-control-plane",
      status: "ok",
    }),
  )
  // Another cell asks whether this cell holds a webhook's tenant.
  .post("/api/internal/cells/webhook-tenant", async (context) => {
    if (
      !verifyBearerToken(
        context.req.header("authorization") ?? null,
        // An empty token fails closed instead of falling back to the
        // general internal token.
        process.env.RESPONDER_CELL_TOKEN?.trim() ?? "",
      )
    ) {
      return context.json({ error: "Unauthorized" }, 401);
    }
    const parsed = webhookTenantSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) return context.json({ error: "Invalid tenant" }, 400);
    const tenant = parsed.data;
    if (tenant.provider === "automation" || tenant.provider === "integration_account") {
      const held = await hasWebhookTenant(tenant);
      return context.json({ active: held, held });
    }
    return context.json(await webhookTenantState(tenant));
  })
  // Public: the sign-in page offers the other regional cells, if any.
  .get("/api/cells", (context) =>
    context.json(
      cellDirectory() ?? { cells: [], cookieDomain: null, current: null },
    ),
  )
  .get("/api/legacy-account-redirect", async (context) => {
    const session = await getAuth().api
      .getSession({ headers: context.req.raw.headers })
      .catch(() => null);
    if (!session) return context.json({ error: "Unauthorized" }, 401);
    // An unverified account may not own its email, so it neither learns
    // nor changes that address's legacy routing.
    if (!session.user.emailVerified) return context.json({ redirect: false });

    try {
      const redirect = await shouldRedirectLegacyAccount(session.user.email);
      return context.json({
        redirect,
        ...(redirect ? { targetUrl: legacyProductUrl() } : {}),
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "legacy_account_redirect_lookup_failed",
          errorCode: error instanceof Error ? error.constructor.name : "unknown",
          errorMessage: authHandlerErrorMessage(error),
        }),
      );
      return context.json({ error: "Could not determine account routing" }, 500);
    }
  })
  .post("/api/legacy-account-redirect/clear", async (context) => {
    const session = await getAuth().api
      .getSession({ headers: context.req.raw.headers })
      .catch(() => null);
    if (!session) return context.json({ error: "Unauthorized" }, 401);
    if (!session.user.emailVerified) return context.json({ redirect: false });

    try {
      await clearLegacyAccountRedirect(session.user.email);
      return context.json({ redirect: false });
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "legacy_account_redirect_clear_failed",
          errorCode: error instanceof Error ? error.constructor.name : "unknown",
          errorMessage: authHandlerErrorMessage(error),
        }),
      );
      return context.json({ error: "Could not update account routing" }, 500);
    }
  })
  .get("/api/auth/github/callback", (context) => {
    const callbackUrl = new URL(context.req.url);
    callbackUrl.pathname = "/api/integrations/github/callback";
    return context.redirect(callbackUrl.toString());
  })
  .get("/sentry/oauth/callback", (context) => {
    const callbackUrl = new URL(context.req.url);
    callbackUrl.pathname = "/api/integrations/sentry/callback";
    return context.redirect(callbackUrl.toString());
  })
  .get("/api/superuser/users", async (context) => {
    const auth = getAuth();
    const session = await auth.api
      .getSession({ headers: context.req.raw.headers })
      .catch(() => null);
    const superuserEmails = configuredSuperuserEmails();
    if (
      !session ||
      platformRoleForIdentity(session.user, superuserEmails) !== "superuser"
    ) {
      return context.json({ error: "Forbidden" }, 403);
    }

    try {
      const search = context.req.query("search")?.trim();
      const result = await auth.api.listUsers({
        headers: context.req.raw.headers,
        query: {
          limit: 50,
          sortBy: "createdAt",
          sortDirection: "desc",
          ...(search
            ? {
                searchField: "email" as const,
                searchOperator: "contains" as const,
                searchValue: search,
              }
            : {}),
        },
      });
      return context.json({
        ...result,
        users: result.users.map((user) => ({
          ...user,
          canImpersonate: canImpersonateSupportUser(
            {
              banned: user.banned ?? null,
              email: user.email,
              role: user.role ?? null,
            },
            superuserEmails,
          ),
        })),
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "superuser_list_users_failed",
          actorUserId: session.user.id,
          errorCode: error instanceof Error ? error.constructor.name : "unknown",
          errorMessage: authHandlerErrorMessage(error),
        }),
      );
      return context.json({ error: "Could not load users" }, 500);
    }
  })
  .on(["GET", "POST"], "/api/auth/*", (context) =>
    handleAuthRequest(context.req.raw),
  )
  .all(`${consentBasePath}/*`, (context) =>
    handleConsentRequest(context.req.raw),
  )
  // Public: the SMS opt-in form records each consent.
  .route("/api/sms-consent", smsConsentRoutes)
  .get("/api/context", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }

    return context.json({
      capabilities: await listEnabledOrganizationCapabilities(
        tenant.organizationId,
      ),
      organizationId: tenant.organizationId,
      user: tenant.user,
    });
  })
  .route("/.well-known", oauthMetadataRoutes)
  .route("/api/v1", managementApiRoutes)
  .route("/api/mcp", managementMcpRoutes)
  .route("/api/api-keys", apiKeyRoutes)
  .route("/api/automations", automationRoutes)
  .route("/api/automation-templates", sharedAutomationTemplateRoutes)
  .route("/api/pull-requests", pullRequestRoutes)
  .route("/api/agents", agentRoutes)
  .route("/api/skills", skillRoutes)
  .route("/api/billing", billingRoutes)
  .route("/api/issues", issueRoutes)
  .route("/api/scans", scanRoutes)
  .route("/api/suggestions", suggestionRoutes)
  .route("/api/ingest", createIngestRoutes())
  .route("/api/telemetry/browser", createBrowserRelayRoutes())
  .route("/api/telemetry/ingest-keys", createIngestKeyRoutes())
  .route("/api/telemetry/sources", createSourceRoutes())
  .route("/api/telemetry/alerts", createAlertRoutes())
  .route("/api/synthetic-checks", createSyntheticRoutes())
  .route("/api/terraform", terraformRoutes)
  .route("/api/error-issues", createErrorIssueRoutes())
  .route("/api/telemetry/dashboards", createDashboardRoutes())
  .route("/api/telemetry", createTelemetryRoutes())
  .route("/api/automation-model-broker", automationModelBrokerRoutes)
  .route(
    "/api/automation-context-broker",
    createAutomationContextBrokerRoutes(),
  )
  .route("/api/integrations", integrationRoutes)
  .route("/api/webhooks/github", githubWebhookRoutes)
  .route("/api/webhooks/sentry", sentryWebhookRoutes)
  .route("/api/webhooks/dash0", dash0WebhookRoutes)
  .route("/api/webhooks/axiom", axiomWebhookRoutes)
  .route("/api/webhooks/devrev", devrevWebhookRoutes)
  .route("/api/webhooks/signoz", signozWebhookRoutes)
  .route("/api/webhooks/honeycomb", honeycombWebhookRoutes)
  .route("/api/webhooks/betterstack", betterStackWebhookRoutes)
  .route("/api/webhooks/slack", slackWebhookRoutes)
  .route("/api/webhooks/discord", discordWebhookRoutes)
  .route("/api/webhooks/linear", linearWebhookRoutes)
  .route("/api/webhooks/automations", automationWebhookRoutes)
  .post("/api/investigations", async (context) => {
    const authorization = context.req.header("authorization") ?? null;
    if (!authorization || !verifyBearerToken(authorization)) {
      return context.json({ error: "Unauthorized" }, 401);
    }

    const parsed = investigationRequestSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return context.json(
        { error: "Invalid investigation", issues: parsed.error.issues },
        400,
      );
    }

    try {
      const result = await queueInvestigation(parsed.data);
      if (result.kind === "blocked") {
        return context.json({
          error: "Monthly investigation allowance exhausted",
          code: "payment_required",
          blocked: true,
        });
      }
      return context.json(
        {
          duplicate: result.kind === "duplicate",
          investigationId: result.investigationId,
          ...(result.kind === "queued" ? { jobId: result.jobId } : {}),
        },
        result.kind === "queued" ? 202 : 200,
      );
    } catch (error) {
      return context.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Unable to queue investigation",
        },
        503,
      );
    }
  });

export type AppType = typeof app;
