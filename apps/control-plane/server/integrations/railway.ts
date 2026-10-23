import { CustomMcpOAuthProvider } from "@responder/core/integrations/custom-mcp";
import {
  railwaySharedWorkspaces,
  railwayUserinfo,
  type RailwayAccessLevel,
  type RailwayFetch,
  type RailwayWorkspace,
} from "@responder/core/integrations/railway";
import { integrationCallbackUrl } from "./urls.js";

// Railway does not register OAuth clients dynamically. It reads the client's
// metadata from an HTTPS URL that is also its client ID, so each deployment
// identifies itself by its own public address.
export function railwayClientMetadataUrl(): string {
  return integrationCallbackUrl("railway").replace(/\/callback$/u, "/client-metadata.json");
}

export function railwayClientMetadataDocument(): Record<string, unknown> {
  const { clientMetadata } = new CustomMcpOAuthProvider({
    redirectUrl: integrationCallbackUrl("railway"),
  });
  return { ...clientMetadata, client_id: railwayClientMetadataUrl() };
}

/**
 * Names a new Railway connection. The Railway user and access level are the
 * connection's identity, so reconnecting the same user at the same level
 * updates its connection, and read-only and redeploy access stay separate
 * connections. The shared workspaces are kept for display and for the agent.
 */
export async function railwayConnectionProfile(
  input: { accessLevel: RailwayAccessLevel; accessToken: string },
  fetchFn?: RailwayFetch,
): Promise<{
  displayName: string;
  email?: string;
  externalAccountId: string;
  workspaces: RailwayWorkspace[];
}> {
  const user = await railwayUserinfo(input.accessToken, fetchFn);
  let workspaces: RailwayWorkspace[] = [];
  try {
    workspaces = await railwaySharedWorkspaces({
      accessToken: input.accessToken,
      ...(fetchFn ? { fetch: fetchFn } : {}),
    });
  } catch (error) {
    // The tools list workspaces again when none were stored.
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : "Unknown error",
      event: "railway_workspace_listing_failed",
    }));
  }
  const [onlyWorkspace] = workspaces;
  const name = workspaces.length === 1 && onlyWorkspace
    ? onlyWorkspace.name
    : user.email
      ? workspaces.length > 1
        ? `${user.email} · ${workspaces.length} workspaces`
        : user.email
      : "Railway";
  return {
    displayName: input.accessLevel === "redeploy" ? `${name} · redeploy` : name,
    ...(user.email ? { email: user.email } : {}),
    externalAccountId: `${user.sub}:${input.accessLevel}`,
    workspaces,
  };
}
