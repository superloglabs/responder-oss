import { tool } from "@openai/agents";
import type { RuntimeRailwayConnection } from "@responder/core/db/investigations";
import {
  callRailwayTool,
  railwayToolDescriptions,
  railwayToolInputSchemas,
  railwayToolNames,
  railwayWorkspaceList,
  type RailwayToolName,
} from "@responder/core/integrations/railway";
import { z } from "zod";

function selectedConnection(
  connections: RuntimeRailwayConnection[],
  accountId?: string,
): RuntimeRailwayConnection {
  if (accountId) {
    const connection = connections.find((candidate) => candidate.accountId === accountId);
    if (!connection) throw new Error("Choose a connected Railway account");
    return connection;
  }
  if (connections.length !== 1) {
    throw new Error("Specify accountId when more than one Railway account is connected");
  }
  return connections[0]!;
}

/** How the agent reads a connection: its workspaces, or its name. */
export function railwayConnectionLabel(connection: RuntimeRailwayConnection): string {
  return connection.workspaces.length > 0
    ? railwayWorkspaceList(connection.workspaces)
    : JSON.stringify(connection.displayName);
}

/**
 * Railway tools for an investigation. Every connection gets the read tools.
 * Redeploy and restart are added only when the run may change things (tag
 * mode) and a connection was granted redeploy access.
 */
export function createRailwayTools(
  connections: RuntimeRailwayConnection[],
  options: { allowWrites: boolean },
) {
  if (connections.length === 0) return [];
  const names = new Set<RailwayToolName>(
    connections.flatMap((connection) => railwayToolNames(connection, options.allowWrites)),
  );
  const accounts = connections
    .map((connection) => `${connection.accountId} (${railwayConnectionLabel(connection)})`)
    .join(", ");
  return [...names].map((name) =>
    tool({
      name,
      description: connections.length > 1
        ? `${railwayToolDescriptions[name]} Connected accounts: ${accounts}`
        : railwayToolDescriptions[name],
      parameters: z.object({
        accountId: z.string().uuid().optional(),
        ...railwayToolInputSchemas[name].shape,
      }),
      async execute({ accountId, ...args }) {
        const connection = selectedConnection(connections, accountId);
        return callRailwayTool({
          allowWrites: options.allowWrites,
          args,
          connection,
          name,
        });
      },
    })
  );
}
