import { z } from "zod";
import type { AutomationContextBrokerClaim } from "../../../../packages/core/src/db/automation-model-broker.js";
import { decryptCredentials } from "../../../../packages/core/src/credentials/encryption.js";
import {
  callVercelApi,
  searchVercelApi,
  vercelCallInputSchema,
  vercelCallToolDescription,
  vercelCredentialsSchema,
  vercelSearchInputSchema,
  vercelSearchToolDescription,
  type VercelReadConnection,
} from "../../../../packages/core/src/integrations/vercel.js";

// Automation runs get the same two Vercel tools as investigations, served by
// the broker so the installation token stays in the control plane. Calls
// reach only the projects the installation shares with Responder.

export interface VercelToolDependencies {
  callApi: typeof callVercelApi;
}

export const defaultVercelToolDependencies: VercelToolDependencies = {
  callApi: callVercelApi,
};

const readOnlyAnnotations = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
  readOnlyHint: true,
};

function inputSchema(schema: z.ZodType) {
  const jsonSchema: Record<string, unknown> = z.toJSONSchema(schema, { io: "input" });
  delete jsonSchema.$schema;
  return jsonSchema;
}

export const vercelToolDefinitions = [
  {
    annotations: readOnlyAnnotations,
    description: vercelSearchToolDescription,
    inputSchema: inputSchema(vercelSearchInputSchema),
    name: "search_vercel_api",
  },
  {
    annotations: readOnlyAnnotations,
    description: vercelCallToolDescription,
    inputSchema: inputSchema(vercelCallInputSchema),
    name: "call_vercel_api",
  },
];

export type VercelToolResult = {
  content: Array<{ text: string; type: "text" }>;
  isError?: true;
};

function failure(message: string): VercelToolResult {
  return { content: [{ text: message, type: "text" }], isError: true };
}

/** The connection's token and the projects its installation shares. */
export function vercelContextConnection(
  claim: AutomationContextBrokerClaim,
): VercelReadConnection | null {
  if (!claim.account.encryptedCredentials) return null;
  const credentials = vercelCredentialsSchema.parse(
    decryptCredentials<Record<string, unknown>>(claim.account.encryptedCredentials),
  );
  return {
    accessToken: credentials.accessToken,
    projectIds: claim.resources
      .filter((resource) => resource.kind === "vercel_project")
      .map((resource) => resource.externalId),
    teamId: credentials.teamId,
  };
}

// Vercel API errors go back to the agent as tool errors so it can adjust.
export async function callVercelTool(input: {
  args: unknown;
  connection: VercelReadConnection;
  dependencies: VercelToolDependencies;
  name: string;
  signal: AbortSignal;
}): Promise<VercelToolResult | null> {
  try {
    if (input.name === "search_vercel_api") {
      const args = vercelSearchInputSchema.safeParse(input.args ?? {});
      if (!args.success) return failure("Invalid tool arguments");
      return { content: [{ text: searchVercelApi(args.data), type: "text" }] };
    }
    if (input.name === "call_vercel_api") {
      const args = vercelCallInputSchema.safeParse(input.args ?? {});
      if (!args.success) return failure("Invalid tool arguments");
      const text = await input.dependencies.callApi(input.connection, args.data, input.signal);
      return { content: [{ text, type: "text" }] };
    }
  } catch (error) {
    return failure(`Vercel ${input.name} failed: ${error instanceof Error ? error.message.slice(0, 500) : "request failed"}`);
  }
  return null;
}
