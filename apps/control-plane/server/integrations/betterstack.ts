import {
  betterStackAuthorization,
  BETTER_STACK_MCP_URL,
} from "../../../../packages/core/src/integrations/betterstack.js";

export class BetterStackCredentialsError extends Error {
  constructor() {
    super("Better Stack rejected the API token. Use a global API token from Better Stack → API tokens.");
  }
}

// Verifies an API token against Better Stack's MCP server, which is the only
// place runs use it. A global token covers the whole Better Stack
// organization, so a workspace has one Better Stack connection and
// reconnecting replaces its token.
export async function betterStackAccount(input: { apiToken: string }) {
  const response = await fetch(BETTER_STACK_MCP_URL, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "responder-connection-check", version: "1" },
        protocolVersion: "2025-06-18",
      },
    }),
    headers: {
      accept: "application/json, text/event-stream",
      authorization: betterStackAuthorization(input),
      "content-type": "application/json",
    },
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  await response.body?.cancel().catch(() => undefined);
  if (response.status === 401 || response.status === 403) {
    throw new BetterStackCredentialsError();
  }
  if (!response.ok) throw new Error(`Better Stack returned ${response.status}`);
  return {
    displayName: "Better Stack",
    externalAccountId: BETTER_STACK_MCP_URL,
    metadata: { mcpUrl: BETTER_STACK_MCP_URL },
  };
}
