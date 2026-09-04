import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as Sentry from "@sentry/hono/node";
import { createHash } from "node:crypto";
import { verifyBearerToken } from "../../../packages/core/src/auth/internal.js";
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
import { integrationRoutes } from "./integrations/routes.js";
import { issueRoutes } from "./issues/routes.js";
import { knowledgeRoutes } from "./knowledge/routes.js";
import { queueInvestigation } from "./investigations/queue.js";
import { getActiveTenant } from "./tenant.js";
import { githubWebhookRoutes } from "./webhooks/github.js";
import { sentryWebhookRoutes } from "./webhooks/sentry.js";
import { dash0WebhookRoutes } from "./webhooks/dash0.js";
import { slackWebhookRoutes } from "./webhooks/slack.js";

const sessionCookiePattern =
  /(?:^|[;,]\s*)(?:__Secure-)?(?:better-auth|responder-auth)\.session_token=/;

export const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
// GitHub accepts webhook deliveries up to 25 MiB. Keep signed provider
// callbacks compatible while retaining a finite in-process buffering bound.
export const MAX_WEBHOOK_REQUEST_BODY_BYTES = 25 * 1024 * 1024;

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
const githubWebhookPaths = new Set([
  "/api/webhooks/github",
  "/api/webhooks/github/",
]);
instrumentedApp.use("*", (context, next) =>
  githubWebhookPaths.has(context.req.path)
    ? githubWebhookBodyLimit(context, next)
    : apiBodyLimit(context, next),
);
if (Sentry.isInitialized()) {
  instrumentedApp.use(Sentry.sentry(instrumentedApp));
  instrumentedApp.use(async (_context, next) => {
    Sentry.setTag("service", "responder-control-plane");
    await next();
  });
}

export const app = instrumentedApp
  .get("/api/health", (context) =>
    context.json({
      service: "responder-control-plane",
      status: "ok",
    }),
  )
  .get("/api/legacy-account-redirect", async (context) => {
    const session = await getAuth().api
      .getSession({ headers: context.req.raw.headers })
      .catch(() => null);
    if (!session) return context.json({ error: "Unauthorized" }, 401);

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
  .get("/api/context", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }

    return context.json({
      organizationId: tenant.organizationId,
      user: tenant.user,
    });
  })
  .route("/api/agents", agentRoutes)
  .route("/api/billing", billingRoutes)
  .route("/api/issues", issueRoutes)
  .route("/api/knowledge", knowledgeRoutes)
  .route("/api/integrations", integrationRoutes)
  .route("/api/webhooks/github", githubWebhookRoutes)
  .route("/api/webhooks/sentry", sentryWebhookRoutes)
  .route("/api/webhooks/dash0", dash0WebhookRoutes)
  .route("/api/webhooks/slack", slackWebhookRoutes)
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
