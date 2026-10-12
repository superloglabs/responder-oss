import { tool } from "@openai/agents";
import type { RuntimeVercelConnection } from "@responder/core/db/investigations";
import {
  callVercelApi,
  searchVercelApi,
  vercelCallInputSchema,
  vercelCallToolDescription,
  vercelSearchInputSchema,
  vercelSearchToolDescription,
} from "@responder/core/integrations/vercel";
import { z } from "zod";

function selectedConnection(
  connections: RuntimeVercelConnection[],
  accountId?: string,
): RuntimeVercelConnection {
  if (accountId) {
    const connection = connections.find((candidate) => candidate.accountId === accountId);
    if (!connection) throw new Error("Choose a connected Vercel account");
    return connection;
  }
  if (connections.length !== 1) {
    throw new Error("Specify accountId when more than one Vercel account is connected");
  }
  return connections[0]!;
}

export function createVercelTools(connections: RuntimeVercelConnection[]) {
  if (connections.length === 0) return [];
  const accountDescription = connections
    .map((connection) => connection.accountId)
    .join(", ");
  const searchTool = tool({
    name: "search_vercel_api",
    description: vercelSearchToolDescription,
    parameters: vercelSearchInputSchema,
    execute: searchVercelApi,
  });
  const callTool = tool({
    name: "call_vercel_api",
    description: `${vercelCallToolDescription} Connected accounts: ${accountDescription}`,
    parameters: z.object({
      accountId: z.string().uuid().optional(),
      ...vercelCallInputSchema.shape,
    }),
    async execute({ accountId, ...input }) {
      return callVercelApi(selectedConnection(connections, accountId), input);
    },
  });
  return [searchTool, callTool];
}
