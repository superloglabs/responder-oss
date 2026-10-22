import { z } from "zod";
import { connectionWebhookSecret } from "./webhook-secret.js";

// Better Stack's hosted MCP server serves Incidents (monitors, incidents,
// on-call) and Telemetry (logs, metrics, errors) for one organization.
export const BETTER_STACK_MCP_URL = "https://mcp.betterstack.com";

// Incident pages live under the signed-in member's team. Team 0 opens the
// incident in whichever team owns it.
export const BETTER_STACK_INCIDENTS_URL = "https://incidents.betterstack.com";

const betterStackCredentialsSchema = z.object({
  apiToken: z.string().min(1),
  authType: z.literal("api_token"),
});

export type BetterStackCredentials = z.infer<typeof betterStackCredentialsSchema>;

// The MCP endpoint is fixed, so a stored value cannot point the broker at
// another host.
export function parseBetterStackCredentials(
  input: unknown,
): BetterStackCredentials & { mcpUrl: string } {
  return { ...betterStackCredentialsSchema.parse(input), mcpUrl: BETTER_STACK_MCP_URL };
}

export function betterStackAuthorization(credentials: { apiToken: string }): string {
  return `Bearer ${credentials.apiToken}`;
}

export function betterStackIncidentUrl(incidentId: string): string {
  return `${BETTER_STACK_INCIDENTS_URL}/team/0/incidents/${encodeURIComponent(incidentId)}`;
}

// The secret Better Stack sends with incident webhooks for one connection.
export function betterStackWebhookSecret(
  integrationAccountId: string,
  encodedKey = process.env.CREDENTIAL_ENCRYPTION_KEY,
): string {
  return connectionWebhookSecret("betterstack", integrationAccountId, encodedKey);
}
