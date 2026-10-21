import { z } from "zod";
import {
  honeycombAuthorization,
  type HoneycombRegion,
} from "../../../../packages/core/src/integrations/honeycomb.js";

// GET /2/auth answers in JSON:API with the key and its team.
const honeycombAuthSchema = z.object({
  data: z.object({
    attributes: z.object({
      name: z.string().optional(),
      scopes: z.array(z.string()).optional(),
    }).passthrough().optional(),
    relationships: z.object({
      team: z.object({ data: z.object({ id: z.string().min(1) }) }),
    }).passthrough(),
  }).passthrough(),
  included: z.array(z.object({
    attributes: z.object({
      name: z.string().optional(),
      slug: z.string().min(1).optional(),
    }).passthrough().optional(),
    id: z.string(),
    type: z.string(),
  }).passthrough()).optional(),
});

export class HoneycombCredentialsError extends Error {
  constructor() {
    super("Honeycomb rejected the API key. Check the key ID, the secret, and the region.");
  }
}

export class HoneycombScopesError extends Error {
  constructor() {
    super("The Honeycomb key needs read access to Model Context Protocol and Environments.");
  }
}

// Honeycomb's MCP server needs read access to MCP and to environments. A
// write scope includes read. Scope IDs look like `environments:read`.
function hasMcpScopes(scopes: string[]): boolean {
  const granted = scopes.map((scope) => scope.toLowerCase());
  const covers = (resource: RegExp) =>
    granted.some((scope) => {
      const [name, access] = scope.split(":");
      return resource.test(name ?? "") && (access === "read" || access === "write");
    });
  return covers(/^environments?$/u) && covers(/^(?:mcp|model[-_]?context[-_]?protocol)$/u);
}

// Verifies a management API key against the team's region. The team
// identifies the connection.
export async function honeycombAccount(input: {
  keyId: string;
  keySecret: string;
  region: HoneycombRegion;
}) {
  const response = await fetch(`${input.region.apiUrl}/2/auth`, {
    headers: {
      accept: "application/vnd.api+json",
      authorization: honeycombAuthorization(input),
    },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 401 || response.status === 403) {
    throw new HoneycombCredentialsError();
  }
  if (!response.ok) throw new Error(`Honeycomb returned ${response.status}`);

  const payload = honeycombAuthSchema.parse(await response.json());
  const scopes = payload.data.attributes?.scopes;
  if (scopes && !hasMcpScopes(scopes)) throw new HoneycombScopesError();
  const teamId = payload.data.relationships.team.data.id;
  const team = payload.included?.find((item) => item.type === "teams" && item.id === teamId);
  const teamSlug = team?.attributes?.slug;
  const teamName = team?.attributes?.name?.trim() || teamSlug || teamId;
  return {
    displayName: teamName,
    externalAccountId: `${input.region.id}:${teamId}`,
    metadata: {
      ...(payload.data.attributes?.name ? { keyName: payload.data.attributes.name } : {}),
      mcpUrl: input.region.mcpUrl,
      region: input.region.id,
      teamId,
      ...(teamSlug ? { teamSlug, teamUrl: `${input.region.uiUrl}/${encodeURIComponent(teamSlug)}` } : {}),
    },
  };
}
