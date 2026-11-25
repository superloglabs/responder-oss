import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from "better-auth/api";
import {
  markEmailVerified,
  revokeUserCredentials,
} from "../../../packages/core/src/db/user-credentials.js";

// Added to the confirmation link's return path when it is opened without
// the session of the account it confirms.
export const emailConfirmationSignInRequired = "SIGN_IN_REQUIRED";

export type CredentialRevocationReason =
  | "ban"
  | "password_change"
  | "password_reset"
  | "password_set_by_support";

export async function revokeCredentialsFor(
  userId: string,
  reason: CredentialRevocationReason,
  keepSessionToken?: string,
): Promise<void> {
  try {
    const revoked = await revokeUserCredentials(userId, { keepSessionToken });
    console.info(JSON.stringify({ event: "user_credentials_revoked", reason, userId, ...revoked }));
  } catch (error) {
    console.error(
      JSON.stringify({
        errorCode: error instanceof Error ? error.constructor.name : "unknown",
        event: "user_credentials_revoke_failed",
        reason,
        userId,
      }),
    );
    throw error;
  }
}

// A reset proves the person owns the address, and ends every credential the
// account had, including any held by whoever chose the old password.
export async function afterPasswordReset(user: { emailVerified: boolean; id: string }) {
  await revokeCredentialsFor(user.id, "password_reset");
  if (!user.emailVerified) await markEmailVerified(user.id);
}

// The user ID Better Auth puts in an email confirmation token. The endpoint
// still checks the signature; this only reads whom the token is for.
export function emailConfirmationTokenUserId(token: unknown): string | null {
  if (typeof token !== "string") return null;
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    if (claims && typeof claims === "object" && "userId" in claims) {
      return typeof claims.userId === "string" ? claims.userId : null;
    }
  } catch {
    return null;
  }
  return null;
}

// A path on this site, so a refused link can return there without becoming
// an open redirect.
export function sameSitePath(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("/")) return null;
  if (value.startsWith("//") || value.includes("\\")) return null;
  return value;
}

export const accountSecurityBeforeHook = createAuthMiddleware(async (ctx) => {
  // Confirmation links go only to signed-in people, for their own address.
  if (ctx.path === "/send-verification-email") {
    if (!(await getSessionFromCtx(ctx))) {
      throw new APIError("UNAUTHORIZED", { message: "Sign in to confirm your email." });
    }
    return;
  }
  // Owning the address is not enough: whoever set the account's password
  // could ask for the link. The link confirms the account only in a browser
  // signed in to that account, so both the mailbox and the password belong
  // to the same person.
  if (ctx.path === "/verify-email") {
    const session = await getSessionFromCtx(ctx);
    const userId = emailConfirmationTokenUserId(ctx.query?.token);
    if (session && userId && session.user.id === userId) return;
    const returnPath = sameSitePath(ctx.query?.callbackURL);
    if (!returnPath) {
      throw new APIError("UNAUTHORIZED", {
        message: "Open the confirmation link in the browser where you are signed in.",
      });
    }
    const url = new URL(returnPath, "http://localhost");
    url.searchParams.set("error", emailConfirmationSignInRequired);
    throw ctx.redirect(`${url.pathname}${url.search}${url.hash}`);
  }
});

export const accountSecurityAfterHook = createAuthMiddleware(async (ctx) => {
  if (ctx.context.returned === undefined || isAPIError(ctx.context.returned)) return;
  if (ctx.path === "/change-password") {
    const current = ctx.context.newSession ?? (await getSessionFromCtx(ctx));
    if (!current) return;
    await revokeCredentialsFor(current.user.id, "password_change", current.session.token);
    return;
  }
  if (ctx.path === "/admin/set-user-password") {
    const userId = (ctx.body as { userId?: unknown } | undefined)?.userId;
    if (typeof userId === "string") await revokeCredentialsFor(userId, "password_set_by_support");
  }
});
