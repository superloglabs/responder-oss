import { hkdfSync } from "node:crypto";
import { z } from "zod";
import type { StoredCustomMcpOAuthState } from "./custom-mcp.js";

export const AXIOM_MCP_URL = "https://mcp.axiom.co/mcp";

// The Axiom MCP tools runs may call. Dashboard, monitor, and notifier
// mutation tools are left out.
export const AXIOM_READ_ONLY_MCP_TOOLS = [
  "checkMonitors",
  "exportDashboard",
  "getDashboard",
  "getDatasetSchema",
  "getMetricTagValues",
  "getMonitorHistory",
  "getSavedQueries",
  "listDashboards",
  "listDatasets",
  "listMetricTags",
  "listMetrics",
  "listNotifiers",
  "queryApl",
  "queryMetrics",
  "searchMetrics",
] as const;

export function isAxiomReadOnlyTool(name: string): boolean {
  return (AXIOM_READ_ONLY_MCP_TOOLS as readonly string[]).includes(name);
}

const axiomCredentialsSchema = z.object({
  authType: z.literal("oauth"),
  mcpUrl: z.literal(AXIOM_MCP_URL),
  oauth: z.object({
    clientInformation: z.record(z.string(), z.unknown()).optional(),
    codeVerifier: z.string().min(1).optional(),
    discoveryState: z.record(z.string(), z.unknown()).optional(),
    tokens: z.record(z.string(), z.unknown()).optional(),
  }),
});

export interface AxiomCredentials {
  authType: "oauth";
  mcpUrl: typeof AXIOM_MCP_URL;
  oauth: StoredCustomMcpOAuthState;
}

export function parseAxiomCredentials(input: unknown): AxiomCredentials {
  return axiomCredentialsSchema.parse(input) as AxiomCredentials;
}

// The bearer secret Axiom sends with monitor alerts for one connection. It is
// derived from the credential key, so OAuth refreshes cannot lose it and a
// new connection gets a new secret.
export function axiomWebhookSecret(
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
    `responder:axiom-webhook:${integrationAccountId}`,
    32,
  )).toString("base64url");
}

// The custom webhook body Responder asks Axiom to send. It has the fields of
// Axiom's default body, with text fields quoted so event text that contains
// quotes still makes valid JSON.
export const AXIOM_WEBHOOK_BODY_TEMPLATE = [
  '{"action":{{printf "%q" .Action}},"event":{',
  '"monitorID":{{printf "%q" .MonitorID}},',
  '"title":{{printf "%q" .Title}},',
  '"description":{{printf "%q" .Description}},',
  '"body":{{printf "%q" .Body}},',
  '"queryStartTime":{{printf "%q" .QueryStartTime}},',
  '"queryEndTime":{{printf "%q" .QueryEndTime}},',
  '"timestamp":{{printf "%q" .Timestamp}},',
  '"value":{{.Value}},',
  '"matchedEvent":{{jsonObject .MatchedEvent}},',
  '"groupKeys":{{jsonArray .GroupKeys}},',
  '"groupValues":{{jsonArray .GroupValues}}}}',
].join("");
