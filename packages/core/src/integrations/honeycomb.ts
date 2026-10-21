import { z } from "zod";
import { connectionWebhookSecret } from "./webhook-secret.js";

// Honeycomb teams live in one region. Each region has its own API and hosted
// MCP server.
export const honeycombRegions = [
  {
    apiUrl: "https://api.honeycomb.io",
    id: "us",
    mcpUrl: "https://mcp.honeycomb.io/mcp",
    name: "US",
    uiUrl: "https://ui.honeycomb.io",
  },
  {
    apiUrl: "https://api.eu1.honeycomb.io",
    id: "eu",
    mcpUrl: "https://mcp.eu1.honeycomb.io/mcp",
    name: "EU",
    uiUrl: "https://ui.eu1.honeycomb.io",
  },
] as const;

export type HoneycombRegion = (typeof honeycombRegions)[number];
export type HoneycombRegionId = HoneycombRegion["id"];

export const honeycombRegionIds = honeycombRegions.map((region) => region.id) as [
  HoneycombRegionId,
  ...HoneycombRegionId[],
];

export function getHoneycombRegion(id: HoneycombRegionId): HoneycombRegion {
  return honeycombRegions.find((region) => region.id === id)!;
}

const honeycombCredentialsSchema = z.object({
  authType: z.literal("api_key"),
  keyId: z.string().min(1),
  keySecret: z.string().min(1),
  region: z.enum(honeycombRegionIds),
});

export type HoneycombCredentials = z.infer<typeof honeycombCredentialsSchema>;

// Stored credentials name the region; the API and MCP endpoints are derived
// from it so a stored value cannot point the broker at another host.
export function parseHoneycombCredentials(
  input: unknown,
): HoneycombCredentials & { mcpUrl: string } {
  const credentials = honeycombCredentialsSchema.parse(input);
  return { ...credentials, mcpUrl: getHoneycombRegion(credentials.region).mcpUrl };
}

// Management API keys authenticate as `Bearer <key ID>:<secret>`.
export function honeycombAuthorization(credentials: {
  keyId: string;
  keySecret: string;
}): string {
  return `Bearer ${credentials.keyId}:${credentials.keySecret}`;
}

// The shared secret Honeycomb sends with trigger and SLO alerts for one
// connection.
export function honeycombWebhookSecret(
  integrationAccountId: string,
  encodedKey = process.env.CREDENTIAL_ENCRYPTION_KEY,
): string {
  return connectionWebhookSecret("honeycomb", integrationAccountId, encodedKey);
}
