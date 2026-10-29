import { createHash, timingSafeEqual } from "node:crypto";
import * as Sentry from "@sentry/hono/node";
import { z } from "zod";
import { findLegacyMcpForwardMember } from "../../../../packages/core/src/db/legacy-mcp-forwarding.js";
import type { ManagementContext } from "./operation.js";

// While customers move from the old Superlog product, its MCP server keeps
// authenticating their existing tokens and forwards a migrated project's
// requests here, for the workspace whose ID is the project's ID. The shared
// LEGACY_MCP_FORWARD_TOKEN authenticates the old server; without it,
// forwarded requests are refused. The caller acts as the workspace member
// with the token owner's email, and a token that could only read there can
// only read here. Remove this when the old product shuts down.

export const legacyMcpForwardHeaders = {
  access: "x-legacy-mcp-access",
  email: "x-legacy-mcp-user-email",
  projectId: "x-legacy-mcp-project-id",
  token: "x-legacy-mcp-forward-token",
} as const;

export type LegacyMcpForward = { context: ManagementContext; readOnly: boolean };

export const legacyMcpForwardRefusedBody = {
  code: "forward_refused",
  error: "This forwarded MCP request is not accepted.",
};

export function isLegacyMcpForward(headers: Headers): boolean {
  return headers.has(legacyMcpForwardHeaders.token);
}

function sameSecret(supplied: string, expected: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(supplied), digest(expected));
}

// Null refuses the request: a wrong or unconfigured credential, a workspace
// that is not in this cell, or a person who is not its member.
export async function authenticateLegacyMcpForward(
  headers: Headers,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<LegacyMcpForward | null> {
  const expected = environment.LEGACY_MCP_FORWARD_TOKEN?.trim();
  const supplied = headers.get(legacyMcpForwardHeaders.token) ?? "";
  if (!expected || !sameSecret(supplied, expected)) return null;
  const organizationId = z.uuid().safeParse(headers.get(legacyMcpForwardHeaders.projectId));
  const email = z.email().max(320).safeParse(headers.get(legacyMcpForwardHeaders.email)?.trim());
  if (!organizationId.success || !email.success) return null;
  const principal = await findLegacyMcpForwardMember(organizationId.data, email.data);
  if (!principal) return null;
  Sentry.setUser({ id: principal.user.id, username: principal.user.name });
  Sentry.setTag("organization_id", principal.organizationId);
  return {
    context: {
      ...principal,
      apiKeyId: null,
      clientName: "Legacy MCP connection",
      oauthClientId: "legacy-mcp-forward",
      source: "mcp",
    },
    readOnly: headers.get(legacyMcpForwardHeaders.access) !== "read-write",
  };
}
