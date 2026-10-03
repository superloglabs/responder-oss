import { createHash } from "node:crypto";
import { and, arrayContains, eq, gt, isNull, lte, or } from "drizzle-orm";
import { member, oauthAccessToken, oauthClient, user } from "./auth-schema.js";
import { getDatabase } from "./client.js";

export interface OAuthAccessTokenPrincipal {
  clientId: string;
  organizationId: string;
  role: string;
  user: { email: string; id: string; name: string };
}

// Better Auth's OAuth provider stores the SHA-256 digest of each opaque
// token, base64url-encoded without padding, and returns it with a prefix
// that is not stored.
export function hashOAuthAccessToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

// Resolves an unexpired access token with the required scope whose client
// is enabled and whose person is still a member of the workspace the grant
// was made for.
export async function authenticateOAuthAccessToken(
  token: string,
  input: { prefix: string; scope: string },
  now = new Date(),
): Promise<OAuthAccessTokenPrincipal | null> {
  if (!token.startsWith(input.prefix)) return null;
  const stored = token.slice(input.prefix.length);
  if (!/^[A-Za-z0-9]{32,128}$/u.test(stored)) return null;
  const rows = await getDatabase()
    .select({
      clientId: oauthAccessToken.clientId,
      email: user.email,
      name: user.name,
      organizationId: member.organizationId,
      role: member.role,
      userId: user.id,
    })
    .from(oauthAccessToken)
    .innerJoin(oauthClient, eq(oauthClient.clientId, oauthAccessToken.clientId))
    .innerJoin(user, eq(user.id, oauthAccessToken.userId))
    .innerJoin(
      member,
      and(
        eq(member.organizationId, oauthAccessToken.referenceId),
        eq(member.userId, oauthAccessToken.userId),
      ),
    )
    .where(
      and(
        eq(oauthAccessToken.token, hashOAuthAccessToken(stored)),
        gt(oauthAccessToken.expiresAt, now),
        arrayContains(oauthAccessToken.scopes, [input.scope]),
        or(isNull(oauthClient.disabled), eq(oauthClient.disabled, false)),
        or(
          isNull(user.banned),
          eq(user.banned, false),
          lte(user.banExpires, now),
        ),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    clientId: row.clientId,
    organizationId: row.organizationId,
    role: row.role,
    user: { email: row.email, id: row.userId, name: row.name },
  };
}
