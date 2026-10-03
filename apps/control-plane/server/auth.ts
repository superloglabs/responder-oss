import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { captureAnalyticsEvent } from "@responder/core/analytics";
import { captureRedditSignupConversion } from "@responder/core/reddit-conversions";
import { captureXSignupConversion } from "@responder/core/x-conversions";
import { getDatabase } from "../../../packages/core/src/db/client.js";
import {
  getAuthUserSupportIdentity,
  setPlatformRole,
  type AuthUserSupportIdentity,
  type PlatformRole,
} from "../../../packages/core/src/db/superusers.js";
import {
  newOrganizationCapabilities,
  setOrganizationCapability,
} from "../../../packages/core/src/db/organization-capabilities.js";
import {
  rememberedOrganizationId,
  rememberOrganization,
} from "../../../packages/core/src/db/workspace-preferences.js";
import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { admin, organization } from "better-auth/plugins";
import {
  adminAc as superuserAc,
  userAc,
} from "better-auth/plugins/admin/access";
import {
  adminAc as organizationAdminAc,
  memberAc as organizationMemberAc,
} from "better-auth/plugins/organization/access";
import { allowsMarketing } from "./consent-policy.js";
import { sendEmail, workspaceInvitationEmailBody } from "./email.js";
import {
  mcpAccessTokenPrefix,
  mcpOAuthPagePath,
  mcpOAuthScopes,
  mcpRefreshTokenPrefix,
  mcpResourceUrl,
} from "./mcp-oauth.js";

export const superuserRoles = {
  superuser: superuserAc,
  user: userAc,
};

export function authHandlerErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "internal_error";
  const detail = `${error.constructor.name} ${error.message}`.toLowerCase();
  if (/timeout|timed out|etimedout/.test(detail)) return "timeout_error";
  if (/database|postgres|connection|econnrefused/.test(detail)) {
    return "database_error";
  }
  if (/secret|required|config|environment/.test(detail)) {
    return "configuration_error";
  }
  if (/fetch|network|enotfound|eai_again/.test(detail)) return "network_error";
  return "internal_error";
}

export function configuredSuperuserEmails(
  environment: NodeJS.ProcessEnv = process.env,
): Set<string> {
  return new Set(
    (environment.SUPERUSER_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function configuredAuthTrustedOrigins(
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  const baseURL = environment.BETTER_AUTH_URL ?? "http://localhost:3000";
  return Array.from(
    new Set(
      [baseURL, environment.RESPONDER_PUBLIC_URL?.trim()].filter(
        (origin): origin is string => Boolean(origin),
      ),
    ),
  );
}

export function platformRoleForIdentity(
  identity: Pick<AuthUserSupportIdentity, "email" | "emailVerified">,
  superuserEmails: ReadonlySet<string>,
): PlatformRole {
  return identity.emailVerified &&
    superuserEmails.has(identity.email.trim().toLowerCase())
    ? "superuser"
    : "user";
}

export function canImpersonateSupportUser(
  target: Pick<AuthUserSupportIdentity, "banned" | "email" | "role"> | null,
  superuserEmails: ReadonlySet<string>,
): boolean {
  return Boolean(
    target &&
      !target.banned &&
      !target.role?.split(",").includes("superuser") &&
      !superuserEmails.has(target.email.toLowerCase()),
  );
}

async function synchronizeSuperuserRole(
  userId: string,
  email: string,
  emailVerified: boolean,
  context: "session_create_before" | "user_create_after",
) {
  const role = platformRoleForIdentity(
    { email, emailVerified },
    configuredSuperuserEmails(),
  );
  try {
    await setPlatformRole(userId, role);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "superuser_role_sync_failed",
        userId,
        role,
        context,
        errorCode: error instanceof Error ? error.constructor.name : "unknown",
        errorMessage: authHandlerErrorMessage(error),
      }),
    );
    throw error;
  }
}

// Social sign-ups arrive on Better Auth's "/callback/:id" route, so the
// provider is the route parameter rather than part of the path.
export function authSignupMethod(
  context: { path?: string; params?: Record<string, unknown> } | null | undefined,
): "email" | "github" | "google" | "unknown" {
  const path = context?.path ?? "";
  const provider = path.startsWith("/callback/") ? context?.params?.id : undefined;
  if (provider === "google" || provider === "github") return provider;
  if (path === "/sign-up/email") return "email";
  return "unknown";
}

export function createResponderAuth() {
  const baseURL = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error("BETTER_AUTH_SECRET is required for authentication");
  }
  const googleClientId = process.env.AUTH_GOOGLE_CLIENT_ID;
  const googleClientSecret = process.env.AUTH_GOOGLE_CLIENT_SECRET;
  const githubClientId = process.env.AUTH_GITHUB_CLIENT_ID;
  const githubClientSecret = process.env.AUTH_GITHUB_CLIENT_SECRET;

  return betterAuth({
    appName: "Superlog",
    baseURL,
    database: drizzleAdapter(getDatabase(), {
      provider: "pg",
    }),
    emailAndPassword: {
      enabled: true,
    },
    socialProviders: {
      ...(googleClientId && googleClientSecret
        ? {
            google: {
              clientId: googleClientId,
              clientSecret: googleClientSecret,
            },
          }
        : {}),
      ...(githubClientId && githubClientSecret
        ? {
            github: {
              clientId: githubClientId,
              clientSecret: githubClientSecret,
            },
          }
        : {}),
    },
    user: {
      additionalFields: {
        lastOrganizationId: {
          fieldName: "last_organization_id",
          input: false,
          required: false,
          returned: false,
          type: "string",
        },
      },
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user, context) => {
            await synchronizeSuperuserRole(
              user.id,
              user.email,
              user.emailVerified,
              "user_create_after",
            );
            const signupMethod = authSignupMethod(context);
            await captureAnalyticsEvent({
              distinctId: user.id,
              event: "user signed up",
              properties: {
                email: user.email,
                name: user.name,
                signup_method: signupMethod,
              },
            });
            if (!allowsMarketing(new Headers(context?.headers))) return;
            await Promise.all([
              captureRedditSignupConversion({
                clickId: context?.getCookie("_rdt_cid") ?? undefined,
                conversionId: user.id,
                email: user.email,
                ipAddress:
                  context?.getHeader("x-responder-client-ip") ?? undefined,
                userAgent: context?.getHeader("user-agent") ?? undefined,
              }),
              captureXSignupConversion({
                conversionId: user.id,
                email: user.email,
                twclid: context?.getCookie("responder_twclid") ?? undefined,
              }),
            ]);
          },
        },
      },
      session: {
        create: {
          async before(session) {
            const identity = await getAuthUserSupportIdentity(session.userId);
            if (identity) {
              await synchronizeSuperuserRole(
                session.userId,
                identity.email,
                identity.emailVerified,
                "session_create_before",
              );
            }
            const organizationId = await rememberedOrganizationId(session.userId);
            if (!organizationId) return;
            return { data: { ...session, activeOrganizationId: organizationId } };
          },
        },
        update: {
          async after(session) {
            const organizationId = session.activeOrganizationId;
            if (typeof organizationId === "string" || organizationId === null) {
              await rememberOrganization(session.userId, organizationId);
            }
          },
        },
      },
    },
    plugins: [
      admin({
        adminRoles: ["superuser"],
        defaultRole: "user",
        impersonationSessionDuration: 60 * 60,
        roles: superuserRoles,
      }),
      organization({
        allowUserToCreateOrganization: true,
        creatorRole: "admin",
        roles: {
          admin: organizationAdminAc,
          member: organizationMemberAc,
        },
        sendInvitationEmail: async ({
          email,
          id,
          invitation,
          inviter,
          organization,
          role,
        }) => {
          const invitationUrl = new URL(
            `/invite/${encodeURIComponent(id)}`,
            baseURL,
          ).toString();
          const body = workspaceInvitationEmailBody({
            invitationUrl,
            inviterEmail: inviter.user.email,
            inviterName: inviter.user.name,
            organizationName: organization.name,
            role,
          });
          try {
            await sendEmail({
              ...body,
              idempotencyKey: `workspace-invitation/${id}/${new Date(
                invitation.expiresAt,
              ).getTime()}`,
              subject: `You're invited to ${organization.name} in Superlog`,
              to: email,
            });
            console.info(
              JSON.stringify({
                event: "invitation_email_delivery_success",
                invitationId: id,
                organizationId: organization.id,
              }),
            );
          } catch (error) {
            console.error(
              JSON.stringify({
                errorCode:
                  error instanceof Error ? error.constructor.name : "unknown",
                errorMessage: authHandlerErrorMessage(error),
                event: "invitation_email_delivery_failed",
                invitationId: id,
                organizationId: organization.id,
              }),
            );
          }
        },
        organizationHooks: {
          afterCreateOrganization: async ({ organization, user }) => {
            await grantNewOrganizationCapabilities(organization.id, user.id);
            await captureAnalyticsEvent({
              distinctId: user.id,
              event: "organization created",
              organizationId: organization.id,
              properties: {
                organization_name: organization.name,
                organization_slug: organization.slug,
              },
            });
          },
        },
      }),
      oauthProvider({
        // MCP clients register themselves and authenticate with PKCE.
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        consentPage: mcpOAuthPagePath,
        // Access tokens are opaque and stored hashed, like API keys.
        disableJwtPlugin: true,
        grantTypes: ["authorization_code", "refresh_token"],
        loginPage: mcpOAuthPagePath,
        // Each grant is bound to one workspace: the session's active
        // workspace when the person approves the client.
        postLogin: {
          consentReferenceId: ({ session }) => {
            const organizationId = session?.activeOrganizationId;
            if (typeof organizationId !== "string" || !organizationId) {
              throw new APIError("BAD_REQUEST", {
                error: "invalid_request",
                error_description: "Choose a workspace first",
              });
            }
            return organizationId;
          },
          page: mcpOAuthPagePath,
          shouldRedirect: ({ session }) =>
            typeof session.activeOrganizationId !== "string" ||
            !session.activeOrganizationId,
        },
        prefix: {
          opaqueAccessToken: mcpAccessTokenPrefix,
          refreshToken: mcpRefreshTokenPrefix,
        },
        scopes: mcpOAuthScopes,
        validAudiences: [mcpResourceUrl(baseURL)],
      }),
    ],
    secret,
    trustedOrigins: configuredAuthTrustedOrigins(),
    advanced: {
      cookiePrefix: "responder-auth",
      database: {
        generateId: "uuid",
      },
      ipAddress: {
        ipAddressHeaders: ["x-responder-client-ip"],
      },
    },
  });
}

// A failed grant leaves the organization usable without the capability, and
// the control room can still enable it.
export async function grantNewOrganizationCapabilities(
  organizationId: string,
  userId: string,
  configured = process.env.RESPONDER_NEW_ORGANIZATION_CAPABILITIES,
): Promise<void> {
  for (const capability of newOrganizationCapabilities(configured)) {
    try {
      await setOrganizationCapability({
        capability,
        enabled: true,
        organizationId,
        updatedBy: userId,
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          capability,
          errorCode:
            error instanceof Error ? error.constructor.name : "unknown",
          event: "organization_capability_grant_failed",
          organizationId,
        }),
      );
    }
  }
}

export type ResponderAuth = ReturnType<typeof createResponderAuth>;

let auth: ResponderAuth | undefined;

export function getAuth(): ResponderAuth {
  auth ??= createResponderAuth();
  return auth;
}
