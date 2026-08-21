import { z } from "zod";
import type { StoredCustomMcpOAuthState } from "./custom-mcp.js";

export const AXIOM_MCP_URL = "https://mcp.axiom.co/mcp";

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
