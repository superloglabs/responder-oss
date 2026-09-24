import { z } from "zod";
import type { StoredCustomMcpOAuthState } from "./custom-mcp.js";

export const GRAFANA_CLOUD_MCP_ORIGIN = "https://mcp.grafana.com";
// Grafana Cloud's hosted MCP server also advertises `grafana:write`. Request
// only the read and datasource-query scopes so the consent screen cannot grant
// dashboard, alert, or incident mutations to Responder.
export const GRAFANA_CLOUD_OAUTH_SCOPE = "grafana:read grafana:query";

const GRAFANA_CLOUD_STACK_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.grafana\.net$/u;

export type GrafanaCredentials =
  | {
      authType: "oauth";
      mcpUrl: string;
      oauth: StoredCustomMcpOAuthState;
      stackUrl: string;
    }
  | {
      authType: "service_account";
      grafanaUrl: string;
      serviceAccountToken: string;
    };

const grafanaCredentialsSchema = z.discriminatedUnion("authType", [
  z.object({
    authType: z.literal("oauth"),
    mcpUrl: z.string().url(),
    oauth: z.object({
      clientInformation: z.record(z.string(), z.unknown()).optional(),
      codeVerifier: z.string().min(1).optional(),
      discoveryState: z.record(z.string(), z.unknown()).optional(),
      tokens: z.record(z.string(), z.unknown()).optional(),
    }),
    stackUrl: z.string().url(),
  }),
  z.object({
    authType: z.literal("service_account"),
    grafanaUrl: z.string().url(),
    serviceAccountToken: z.string().min(1),
  }),
]);

export function parseGrafanaCredentials(input: unknown): GrafanaCredentials {
  const credentials = grafanaCredentialsSchema.parse(input) as GrafanaCredentials;
  if (credentials.authType === "oauth") {
    const stack = normalizeGrafanaCloudStackUrl(credentials.stackUrl);
    if (credentials.mcpUrl !== stack.mcpUrl) {
      throw new Error("The Grafana Cloud MCP URL does not match its stack");
    }
    return credentials;
  }
  return {
    ...credentials,
    grafanaUrl: normalizeGrafanaUrl(credentials.grafanaUrl),
  };
}

/**
 * Accepts a Grafana Cloud stack as `acme`, `acme.grafana.net`, or any URL on
 * that stack, and derives the stack-scoped hosted MCP endpoint. Responder never
 * accepts the MCP URL itself from the browser.
 */
export function normalizeGrafanaCloudStackUrl(input: string): {
  mcpUrl: string;
  stackHost: string;
  stackUrl: string;
} {
  const trimmed = input.trim();
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)
    ? trimmed
    : `https://${trimmed.includes(".") ? trimmed : `${trimmed}.grafana.net`}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("Enter your Grafana Cloud stack URL");
  }
  const stackHost = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !GRAFANA_CLOUD_STACK_HOST.test(stackHost)
  ) {
    throw new Error("Enter a Grafana Cloud stack URL ending in .grafana.net");
  }
  return {
    mcpUrl: `${GRAFANA_CLOUD_MCP_ORIGIN}/mcp/${stackHost}`,
    stackHost,
    stackUrl: `https://${stackHost}`,
  };
}

/** Normalizes the root URL of a self-hosted Grafana instance, including a sub-path. */
export function normalizeGrafanaUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Enter the full Grafana URL, including https://");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  const isLoopback = ["localhost", "127.0.0.1", "::1"].includes(hostname);
  const localHttpAllowed =
    process.env.NODE_ENV !== "production" &&
    url.protocol === "http:" &&
    isLoopback;
  if (url.protocol !== "https:" && !localHttpAllowed) {
    throw new Error("Grafana URLs must use HTTPS outside localhost");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "Grafana URLs cannot contain credentials, query parameters, or fragments",
    );
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.toString().replace(/\/$/u, "");
}
