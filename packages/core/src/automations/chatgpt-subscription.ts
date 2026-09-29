import { z } from "zod";

export const subscriptionCliVersion = "0.155.1";
// This is the official client's file-based credential cache, not an API key.
// Only the managed client may create or refresh it.
const nativeAuthSchema = z.object({
  auth_mode: z.literal("chatgpt").optional(),
  OPENAI_API_KEY: z.null().optional(),
  tokens: z.object({
    id_token: z.string().min(1),
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    account_id: z.string().min(1),
  }).passthrough(),
  last_refresh: z.string().optional(),
}).passthrough();
export function parseSubscriptionAuth(authJson: string) {
  if (authJson.length > 131_072) throw new Error("Invalid subscription credential cache");
  return nativeAuthSchema.parse(JSON.parse(authJson));
}

/** When the cached access token expires, or null when it carries no expiry. */
export function subscriptionAccessTokenExpiresAt(authJson: string): Date | null {
  const payload = parseSubscriptionAuth(authJson).tokens.access_token.split(".")[1];
  if (!payload) return null;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof exp === "number" && Number.isFinite(exp) ? new Date(exp * 1_000) : null;
  } catch {
    return null;
  }
}

// A run sandbox holds no real token. The access token is a Daytona secret
// placeholder that Daytona replaces on HTTPS requests to ChatGPT. Refresh tokens
// rotate on every use, so runs get none: a refresh attempt fails that run
// instead of invalidating the stored login. Codex never sends the ID token and
// only reads its claims, so the copy keeps those claims and no signature.
export const runOnlyRefreshToken = "responder-run-only";
export const subscriptionSecretHosts = ["chatgpt.com"];
export const daytonaSecretPlaceholderPrefix = "dtn_secret_";
export function subscriptionAuthForSandbox(authJson: string, accessTokenPlaceholder: string): string {
  if (!accessTokenPlaceholder.startsWith(daytonaSecretPlaceholderPrefix))
    throw new Error("Subscription runs require a Daytona secret placeholder");
  const auth = parseSubscriptionAuth(authJson);
  const payload = auth.tokens.id_token.split(".")[1];
  const claims = payload ? JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown> : {};
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const idToken = `${encode({ alg: "none", typ: "JWT" })}.${encode({
    email: claims.email,
    "https://api.openai.com/auth": claims["https://api.openai.com/auth"],
    "https://api.openai.com/profile": claims["https://api.openai.com/profile"],
  })}.unsigned`;
  return JSON.stringify({
    ...auth,
    tokens: { ...auth.tokens, access_token: accessTokenPlaceholder, id_token: idToken, refresh_token: runOnlyRefreshToken },
  });
}
export interface ManagedSubscriptionLogin extends Record<string, unknown> {
  sandboxId: string;
  userCode: string;
  verificationUrl: string;
}
export interface SubscriptionLoginTransport {
  start(): Promise<ManagedSubscriptionLogin>;
  poll(sandboxId: string): Promise<{ status: "pending" } | { status: "connected"; authJson: string }>;
  cancel(sandboxId: string): Promise<void>;
}
