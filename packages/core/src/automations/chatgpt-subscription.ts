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
