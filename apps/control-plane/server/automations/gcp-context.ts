import {
  createGcpAuthClient,
  GCP_MCP_SERVICES,
  type GcpConnectionCredentials,
  type GcpMcpService,
} from "../../../../packages/core/src/integrations/gcp.js";
import type { ManagedMcpServer } from "./managed-mcp-context.js";

// Automation runs reach a Google Cloud project through the same keyless
// identity as investigations. The broker exposes only tools that Google marks
// read-only, matching the investigation tool filter, and refuses the rest.

const MAX_CACHED_CLIENTS = 200;

export interface GcpContextDependencies {
  authHeaders: (connection: GcpConnectionCredentials) => Promise<Headers>;
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  now: () => number;
}

export function isGcpMcpService(value: string | undefined): value is GcpMcpService {
  return value !== undefined && Object.hasOwn(GCP_MCP_SERVICES, value);
}

const authClients = new Map<string, ReturnType<typeof createGcpAuthClient>>();

/** Federated Google credentials for one connection, refreshed by the client. */
export async function gcpAuthHeaders(
  connection: GcpConnectionCredentials,
): Promise<Headers> {
  const key = `${connection.projectNumber}:${connection.sessionName}`;
  let client = authClients.get(key);
  if (!client) {
    client = createGcpAuthClient(connection);
    authClients.set(key, client);
    if (authClients.size > MAX_CACHED_CLIENTS) {
      authClients.delete(authClients.keys().next().value!);
    }
  }
  const headers = new Headers();
  for (const [name, value] of await client.getRequestHeaders()) {
    headers.set(name, value);
  }
  headers.set("x-goog-user-project", connection.projectId);
  return headers;
}

/** One Google MCP server as the broker reaches it for a connection. */
export function gcpContextServer(input: {
  accountId: string;
  connection: GcpConnectionCredentials;
  dependencies: GcpContextDependencies;
  service: GcpMcpService;
}): ManagedMcpServer {
  return {
    cacheKey: `gcp:${input.accountId}:${input.connection.sessionName}:${input.service}`,
    fetch: input.dependencies.fetch,
    headers: () => input.dependencies.authHeaders(input.connection),
    isAllowed: (tool) => tool.annotations?.readOnlyHint === true,
    label: "Google Cloud MCP",
    now: input.dependencies.now,
    url: GCP_MCP_SERVICES[input.service],
  };
}
