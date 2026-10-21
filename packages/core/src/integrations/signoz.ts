import { z } from "zod";
import { connectionWebhookSecret } from "./webhook-secret.js";

// A SigNoz Cloud instance lives at <tenant>.<region>.signoz.cloud, and the
// region's hosted MCP server at mcp.<region>.signoz.cloud.
const signozCloudHost = /^(?<tenant>[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.(?<region>[a-z]{2}[0-9]?)\.signoz\.cloud$/u;

export interface SignozInstance {
  instanceUrl: string;
  mcpUrl: string;
  region: string;
}

// Reads the instance URL a member pastes, with or without the scheme, a path,
// or a trailing slash. Returns null for anything that is not a SigNoz Cloud
// instance.
export function parseSignozInstanceUrl(input: string): SignozInstance | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.port || url.username || url.password) return null;
  const match = signozCloudHost.exec(url.hostname);
  const region = match?.groups?.region;
  const tenant = match?.groups?.tenant;
  if (!region || !tenant || tenant === "mcp" || tenant === "ingest") return null;
  return {
    instanceUrl: `https://${url.hostname}`,
    mcpUrl: `https://mcp.${region}.signoz.cloud/mcp`,
    region,
  };
}

const signozCredentialsSchema = z.object({
  apiKey: z.string().min(1),
  authType: z.literal("api_key"),
  instanceUrl: z.string().min(1),
});

export type SignozCredentials = z.infer<typeof signozCredentialsSchema>;

// Stored credentials name the instance; the MCP endpoint is derived from it
// so a stored value cannot point the broker at another host.
export function parseSignozCredentials(input: unknown): SignozCredentials & SignozInstance {
  const credentials = signozCredentialsSchema.parse(input);
  const instance = parseSignozInstanceUrl(credentials.instanceUrl);
  if (!instance) throw new Error("The stored SigNoz instance URL is not a SigNoz Cloud instance");
  return { ...credentials, ...instance };
}

// The bearer secret SigNoz sends with alerts for one connection.
export function signozWebhookSecret(
  integrationAccountId: string,
  encodedKey = process.env.CREDENTIAL_ENCRYPTION_KEY,
): string {
  return connectionWebhookSecret("signoz", integrationAccountId, encodedKey);
}
