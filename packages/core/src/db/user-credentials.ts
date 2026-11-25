import { and, eq, isNull, ne } from "drizzle-orm";
import { oauthAccessToken, oauthConsent, oauthRefreshToken, session, user } from "./auth-schema.js";
import { getDatabase } from "./client.js";
import { apiKeys } from "./schema.js";

export interface RevokedUserCredentials {
  apiKeys: number;
  oauthAccessTokens: number;
  oauthConsents: number;
  oauthRefreshTokens: number;
  sessions: number;
}

// Ends every credential a person holds: their sign-in sessions, the API keys
// they created, and the access, refresh, and consent records of the apps they
// approved. Used when their password is reset or changed and when they are
// banned. A password change keeps the session that made it.
//
// Workspace integrations are not touched: Superlog holds those tokens, so
// the person never had them.
export async function revokeUserCredentials(
  userId: string,
  options: { keepSessionToken?: string } = {},
  now = new Date(),
): Promise<RevokedUserCredentials> {
  return getDatabase().transaction(async (tx) => {
    const revokedApiKeys = await tx
      .update(apiKeys)
      .set({ revokedAt: now })
      .where(and(eq(apiKeys.createdBy, userId), isNull(apiKeys.revokedAt)))
      .returning({ id: apiKeys.id });
    const revokedAccessTokens = await tx
      .update(oauthAccessToken)
      .set({ revoked: now })
      .where(and(eq(oauthAccessToken.userId, userId), isNull(oauthAccessToken.revoked)))
      .returning({ id: oauthAccessToken.id });
    const revokedRefreshTokens = await tx
      .update(oauthRefreshToken)
      .set({ revoked: now })
      .where(and(eq(oauthRefreshToken.userId, userId), isNull(oauthRefreshToken.revoked)))
      .returning({ id: oauthRefreshToken.id });
    // Without consent, an app has to ask the person again before it gets a
    // new token.
    const deletedConsents = await tx
      .delete(oauthConsent)
      .where(eq(oauthConsent.userId, userId))
      .returning({ id: oauthConsent.id });
    const deletedSessions = await tx
      .delete(session)
      .where(
        and(
          eq(session.userId, userId),
          ...(options.keepSessionToken ? [ne(session.token, options.keepSessionToken)] : []),
        ),
      )
      .returning({ id: session.id });
    return {
      apiKeys: revokedApiKeys.length,
      oauthAccessTokens: revokedAccessTokens.length,
      oauthConsents: deletedConsents.length,
      oauthRefreshTokens: revokedRefreshTokens.length,
      sessions: deletedSessions.length,
    };
  });
}

// Only the owner of an address receives its password reset link, so using
// one proves the address as well as an email confirmation does.
export async function markEmailVerified(userId: string): Promise<void> {
  await getDatabase()
    .update(user)
    .set({ emailVerified: true, updatedAt: new Date() })
    .where(and(eq(user.id, userId), eq(user.emailVerified, false)));
}
