import { hkdfSync } from "node:crypto";

// The bearer secret a provider sends with webhooks for one connection. It is
// derived from the credential key, so credential refreshes cannot lose it and
// a new connection gets a new secret.
export function connectionWebhookSecret(
  provider: "axiom" | "honeycomb" | "signoz",
  integrationAccountId: string,
  encodedKey = process.env.CREDENTIAL_ENCRYPTION_KEY,
): string {
  if (!encodedKey) throw new Error("CREDENTIAL_ENCRYPTION_KEY is required");
  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== 32) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }
  return Buffer.from(hkdfSync(
    "sha256",
    key,
    Buffer.alloc(0),
    `responder:${provider}-webhook:${integrationAccountId}`,
    32,
  )).toString("base64url");
}
