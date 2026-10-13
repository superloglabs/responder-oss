import { createHmac, randomUUID } from "node:crypto";

const sentryRequestTimeoutMs = 10_000;

function base64Url(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function sentryClientSecretJwt(clientId: string, clientSecret: string): string {
  const issuedAt = Math.floor(Date.now() / 1_000);
  const encodedHeader = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const encodedPayload = base64Url(
    JSON.stringify({
      exp: issuedAt + 60,
      iat: issuedAt,
      iss: clientId,
      sub: clientId,
      jti: randomUUID(),
    }),
  );
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac("sha256", clientSecret)
    .update(signingInput)
    .digest();
  return `${signingInput}.${base64Url(signature)}`;
}

// Requests a new access token for a Sentry App installation and returns
// Sentry's response. Sentry rotates the refresh token on every refresh, so a
// refresh whose response never arrived, such as one that timed out, leaves the
// stored refresh token revoked. Sentry can also revoke it while leaving the
// installation in place. When Sentry rejects the refresh token, a client
// secret JWT gets a token for the installation without it. Timeouts and
// provider outages are left to the caller's retry.
export async function requestSentryTokenRefresh(input: {
  clientId: string;
  clientSecret: string;
  installationId: string;
  refreshToken: string;
}): Promise<Response> {
  const authorizationUrl =
    `https://sentry.io/api/0/sentry-app-installations/${encodeURIComponent(input.installationId)}/authorizations/`;
  const response = await fetch(authorizationUrl, {
    method: "POST",
    signal: AbortSignal.timeout(sentryRequestTimeoutMs),
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      client_id: input.clientId,
      client_secret: input.clientSecret,
    }),
  });
  if (![400, 401, 403].includes(response.status)) return response;

  return fetch(authorizationUrl, {
    method: "POST",
    signal: AbortSignal.timeout(sentryRequestTimeoutMs),
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${sentryClientSecretJwt(input.clientId, input.clientSecret)}`,
    },
    body: JSON.stringify({
      grant_type: "urn:sentry:params:oauth:grant-type:jwt-bearer",
    }),
  });
}
