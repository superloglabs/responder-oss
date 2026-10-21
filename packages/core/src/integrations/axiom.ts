import { z } from "zod";
import type { StoredCustomMcpOAuthState } from "./custom-mcp.js";
import { connectionWebhookSecret } from "./webhook-secret.js";

export const AXIOM_MCP_URL = "https://mcp.axiom.co/mcp";

// The Axiom MCP tools alert investigations and scans may call. Automations and
// tag mode may call every Axiom tool.
export const AXIOM_READ_ONLY_MCP_TOOLS = [
  "checkMonitors",
  "exportDashboard",
  "getDashboard",
  "getDatasetFields",
  "getMetricTagValues",
  "getMonitor",
  "getMonitorHistory",
  "getSavedQueries",
  "listDashboards",
  "listDatasets",
  "listMetricTags",
  "listMetrics",
  "listNotifiers",
  "queryDataset",
  "queryMetrics",
  "searchMetrics",
  "services-getChanges",
  "services-getEdgeHistory",
  "services-getMap",
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

// The bearer secret Axiom sends with monitor alerts for one connection.
export function axiomWebhookSecret(
  integrationAccountId: string,
  encodedKey = process.env.CREDENTIAL_ENCRYPTION_KEY,
): string {
  return connectionWebhookSecret("axiom", integrationAccountId, encodedKey);
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
