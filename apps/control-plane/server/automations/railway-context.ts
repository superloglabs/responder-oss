import { z } from "zod";
import type { AutomationContextBrokerClaim } from "../../../../packages/core/src/db/automation-model-broker.js";
import {
  callRailwayTool,
  railwayToolDescriptions,
  railwayToolInputSchemas,
  railwayToolNames,
  railwayWorkspacesSchema,
  type RailwayAccessLevel,
  type RailwayToolConnection,
} from "../../../../packages/core/src/integrations/railway.js";

// Automation runs get the same Railway tools as investigations, served by the
// broker so the OAuth tokens stay in the control plane. A connection granted
// redeploy access also offers redeploy and restart.

export interface RailwayToolDependencies {
  callTool: typeof callRailwayTool;
}

export const defaultRailwayToolDependencies: RailwayToolDependencies = {
  callTool: callRailwayTool,
};

function inputSchema(schema: z.ZodType) {
  const jsonSchema: Record<string, unknown> = z.toJSONSchema(schema, { io: "input" });
  delete jsonSchema.$schema;
  return jsonSchema;
}

export function railwayToolDefinitions(accessLevel: RailwayAccessLevel) {
  return railwayToolNames({ accessLevel }, true).map((name) => {
    const write = name === "redeploy_railway_deployment" || name === "restart_railway_deployment";
    return {
      annotations: {
        destructiveHint: write,
        idempotentHint: !write,
        openWorldHint: true,
        readOnlyHint: !write,
      },
      description: railwayToolDescriptions[name],
      inputSchema: inputSchema(railwayToolInputSchemas[name]),
      name,
    };
  });
}

/** The workspaces the connection shares, from its metadata. */
export function railwayClaimWorkspaces(claim: AutomationContextBrokerClaim) {
  const workspaces = railwayWorkspacesSchema.safeParse(
    (claim.account.metadata as Record<string, unknown> | null | undefined)?.workspaces,
  );
  return workspaces.success ? workspaces.data : [];
}

export type RailwayToolResult = {
  content: Array<{ text: string; type: "text" }>;
  isError?: true;
};

// Railway API errors go back to the agent as tool errors so it can adjust.
export async function callRailwayContextTool(input: {
  args: unknown;
  connection: RailwayToolConnection;
  dependencies: RailwayToolDependencies;
  name: string;
  signal: AbortSignal;
}): Promise<RailwayToolResult> {
  try {
    const text = await input.dependencies.callTool({
      allowWrites: true,
      args: input.args,
      connection: input.connection,
      name: input.name,
      options: { signal: input.signal },
    });
    return { content: [{ text, type: "text" }] };
  } catch (error) {
    const message = error instanceof z.ZodError
      ? "Invalid tool arguments"
      : `Railway ${input.name} failed: ${error instanceof Error ? error.message.slice(0, 500) : "request failed"}`;
    return { content: [{ text: message, type: "text" }], isError: true };
  }
}
