import { hkdfSync } from "node:crypto";

function deriveWebhookSecret(info: string, encodedKey: string | undefined): string {
  if (!encodedKey) throw new Error("CREDENTIAL_ENCRYPTION_KEY is required");
  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== 32) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }
  return Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), info, 32)).toString("base64url");
}

// The bearer secret a provider sends with webhooks for one connection. It is
// derived from the credential key, so credential refreshes cannot lose it and
// a new connection gets a new secret.
export function connectionWebhookSecret(
  provider: "axiom" | "betterstack" | "honeycomb" | "signoz",
  integrationAccountId: string,
  encodedKey = process.env.CREDENTIAL_ENCRYPTION_KEY,
): string {
  return deriveWebhookSecret(`responder:${provider}-webhook:${integrationAccountId}`, encodedKey);
}

// The bearer token a caller sends to an automation's webhook URL. Each
// automation gets its own, derived the same way as connection secrets.
export function automationWebhookToken(
  automationId: string,
  encodedKey = process.env.CREDENTIAL_ENCRYPTION_KEY,
): string {
  return deriveWebhookSecret(`responder:automation-webhook:${automationId}`, encodedKey);
}
