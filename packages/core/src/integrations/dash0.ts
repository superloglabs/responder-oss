import { randomBytes } from "node:crypto";
import type { StoredCustomMcpOAuthState } from "./custom-mcp.js";
import { validateCustomMcpUrl } from "./custom-mcp.js";
import { z } from "zod";

export interface Dash0Credentials {
  authType: "oauth";
  mcpUrl: string;
  oauth: StoredCustomMcpOAuthState;
  webhookSecret: string;
}

const dash0CredentialsSchema = z.object({
  authType: z.literal("oauth"),
  mcpUrl: z.string().url(),
  oauth: z.object({
    clientInformation: z.record(z.string(), z.unknown()).optional(),
    codeVerifier: z.string().min(1).optional(),
    discoveryState: z.record(z.string(), z.unknown()).optional(),
    tokens: z.record(z.string(), z.unknown()).optional(),
  }),
  webhookSecret: z.string().min(32),
});

export function parseDash0Credentials(input: unknown): Dash0Credentials {
  return dash0CredentialsSchema.parse(input) as Dash0Credentials;
}

export async function normalizeDash0McpUrl(input: string): Promise<string> {
  const candidate = new URL(input);
  const hostname = candidate.hostname.toLowerCase().replace(/\.$/u, "");
  const local =
    process.env.NODE_ENV !== "production" &&
    (hostname === "localhost" || hostname.endsWith(".localhost"));
  if (!local && hostname !== "dash0.com" && !hostname.endsWith(".dash0.com")) {
    throw new Error("Use the MCP endpoint copied from Dash0");
  }
  const url = await validateCustomMcpUrl(candidate, {
    allowLocal: process.env.NODE_ENV !== "production",
  });
  url.hash = "";
  return url.toString();
}

export function createDash0WebhookSecret(): string {
  return randomBytes(32).toString("base64url");
}
