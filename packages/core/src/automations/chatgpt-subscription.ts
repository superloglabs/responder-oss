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

// Refresh tokens rotate on every use, so only one holder may keep one. Runs get
// a copy without it: they share the access token, and a refresh attempt inside
// a run fails that run instead of invalidating the stored login.
export const runOnlyRefreshToken = "responder-run-only";
export function subscriptionAuthForRun(authJson: string): string {
  const auth = parseSubscriptionAuth(authJson);
  return JSON.stringify({ ...auth, tokens: { ...auth.tokens, refresh_token: runOnlyRefreshToken } });
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
