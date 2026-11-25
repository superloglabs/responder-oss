import { createHash, createPublicKey, timingSafeEqual, verify, type KeyObject } from "node:crypto";
import * as Sentry from "@sentry/hono/node";
import { z } from "zod";
import {
  claimLegacyMcpForwardAssertion,
  findForwardedWorkspaceMember,
  type LegacyMcpForwardMember,
} from "../../../../packages/core/src/db/legacy-mcp-forwarding.js";
import { cellOrigin } from "../integrations/urls.js";
import type { ManagementContext } from "./operation.js";

// While customers move from the old Superlog product, its MCP server keeps
// authenticating their existing tokens and forwards a moved project's
// requests here. Each request carries a short-lived assertion the old server
// signs with its Ed25519 key: it names the old project, the token owner's
// email, the access the token had, this cell, and a hash of the request body.
// This cell holds only the public keys, in LEGACY_MCP_FORWARD_PUBLIC_KEYS.
// The request is accepted only for a project listed in legacy_mcp_forwards,
// and acts as the member of its workspace with that email. Each assertion is
// accepted once: its jti is recorded until it expires. A token that could
// only read there can only read here. Remove this when the old product shuts
// down.

export const legacyMcpForwardHeaders = {
  assertion: "x-legacy-mcp-assertion",
} as const;

export type LegacyMcpForward = { context: ManagementContext; readOnly: boolean };

export const legacyMcpForwardRefusedBody = {
  code: "forward_refused",
  error: "This forwarded MCP request is not accepted.",
};

export const legacyMcpAssertionIssuer = "superlog-legacy-mcp";
// The longest an assertion may live, and the clock difference tolerated
// between the two servers.
const maxLifetimeSeconds = 120;
const clockSkewSeconds = 30;

export function isLegacyMcpForward(headers: Headers): boolean {
  return headers.has(legacyMcpForwardHeaders.assertion);
}

const base64url = /^[A-Za-z0-9_-]+$/;

// Each key is the base64url "x" of an Ed25519 public key. Several keys, comma
// separated, let the old server's key be replaced without a gap.
export function legacyMcpForwardPublicKeys(value: string | undefined): KeyObject[] {
  const keys: KeyObject[] = [];
  for (const entry of value?.split(",") ?? []) {
    const x = entry.trim();
    if (!x || !base64url.test(x) || Buffer.from(x, "base64url").length !== 32) continue;
    try {
      keys.push(createPublicKey({ format: "jwk", key: { crv: "Ed25519", kty: "OKP", x } }));
    } catch {
      // An unusable key is skipped; with none left, every assertion is refused.
    }
  }
  return keys;
}

const assertionHeaderSchema = z.object({ alg: z.literal("EdDSA"), typ: z.literal("JWT").optional() });
const assertionClaimsSchema = z.object({
  access: z.enum(["read", "read-write"]),
  aud: z.string(),
  body: z.string().regex(base64url).length(43),
  email: z.email().max(320),
  exp: z.number().int(),
  iat: z.number().int(),
  iss: z.literal(legacyMcpAssertionIssuer),
  jti: z.string().min(16).max(64),
  project: z.uuid(),
});
type AssertionClaims = z.infer<typeof assertionClaimsSchema>;

function decodeJson(segment: string): unknown {
  if (!base64url.test(segment)) return null;
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

// The claims of an assertion signed by one of the keys, addressed to this
// cell, and current. Null otherwise. The body hash is checked separately, so
// a request's body is read only once its assertion is known to be genuine.
export function verifyLegacyMcpAssertion(
  assertion: string,
  { audience, keys, now = Date.now() }: { audience: string; keys: KeyObject[]; now?: number },
): AssertionClaims | null {
  if (keys.length === 0 || assertion.length > 4096) return null;
  const parts = assertion.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];
  if (!assertionHeaderSchema.safeParse(decodeJson(header)).success) return null;
  if (!base64url.test(signature)) return null;
  const signingInput = Buffer.from(`${header}.${payload}`);
  const signatureBytes = Buffer.from(signature, "base64url");
  if (!keys.some((key) => verify(null, signingInput, key, signatureBytes))) return null;
  const claims = assertionClaimsSchema.safeParse(decodeJson(payload));
  if (!claims.success) return null;
  const { aud, exp, iat } = claims.data;
  const seconds = Math.floor(now / 1000);
  if (aud !== audience) return null;
  if (iat > seconds + clockSkewSeconds || exp <= seconds - clockSkewSeconds) return null;
  if (exp <= iat || exp - iat > maxLifetimeSeconds) return null;
  return claims.data;
}

// Whether the body is the one the assertion was made for.
export function assertionCoversBody(claims: AssertionClaims, body: Uint8Array): boolean {
  const digest = createHash("sha256").update(body).digest();
  const expected = Buffer.from(claims.body, "base64url");
  return expected.length === digest.length && timingSafeEqual(expected, digest);
}

function forwardFor(principal: LegacyMcpForwardMember, readOnly: boolean): LegacyMcpForward {
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
    readOnly,
  };
}

// The forward and the request to hand on, whose body has been read once to
// check it. Null refuses the request: a missing, invalid, or expired
// assertion, a different body, an assertion already used, a project that did
// not move to this cell, or a person who is not a member of its workspace.
export async function authenticateLegacyMcpForward(
  request: Request,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ forward: LegacyMcpForward; request: Request } | null> {
  const assertion = request.headers.get(legacyMcpForwardHeaders.assertion);
  if (assertion === null) return null;
  const claims = verifyLegacyMcpAssertion(assertion, {
    audience: cellOrigin(),
    keys: legacyMcpForwardPublicKeys(environment.LEGACY_MCP_FORWARD_PUBLIC_KEYS),
  });
  if (!claims) return null;
  const body = new Uint8Array(await request.arrayBuffer());
  if (!assertionCoversBody(claims, body)) return null;
  // Kept for as long as the assertion could still be accepted.
  const acceptedUntil = new Date((claims.exp + clockSkewSeconds) * 1000);
  if (!(await claimLegacyMcpForwardAssertion(claims.jti, acceptedUntil))) return null;
  const principal = await findForwardedWorkspaceMember(claims.project, claims.email);
  if (!principal) return null;
  return {
    forward: forwardFor(principal, claims.access !== "read-write"),
    request: new Request(request.url, {
      body,
      headers: request.headers,
      method: request.method,
      signal: request.signal,
    }),
  };
}
