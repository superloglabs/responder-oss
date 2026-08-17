import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  CLICKSTACK_CLOUD_MCP_URL,
  CLICKSTACK_CLOUD_OAUTH_ISSUER,
  CLICKSTACK_CLOUD_OAUTH_RESOURCE,
  clickStackTeamUrl,
  normalizeClickStackMcpUrl,
} from "@responder/core/integrations/clickstack";
import { safeCustomMcpFetch } from "@responder/core/integrations/custom-mcp";

const clickStackTeamSchema = z.object({
  data: z.object({
    id: z.string().min(1),
    name: z.string().trim().min(1),
  }),
});

export class ClickStackCredentialsError extends Error {
  constructor() {
    super("ClickStack rejected the Personal API Access Key");
  }
}

export class ClickStackOAuthError extends Error {}

const clickStackRegistrationSchema = z.object({
  client_id: z.string().min(1),
});

export const clickStackCloudTokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  token_type: z.string().min(1).default("Bearer"),
  expires_in: z.number().positive(),
  scope: z.string().optional(),
});

export function createClickStackPkce(): {
  codeChallenge: string;
  codeVerifier: string;
} {
  const codeVerifier = randomBytes(32).toString("base64url");
  return {
    codeChallenge: createHash("sha256")
      .update(codeVerifier)
      .digest("base64url"),
    codeVerifier,
  };
}

export async function registerClickStackCloudClient(
  redirectUri: string,
): Promise<string> {
  const response = await fetch(`${CLICKSTACK_CLOUD_OAUTH_ISSUER}/register`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      client_name: "Responder",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [redirectUri],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    console.error(
      JSON.stringify({
        event: "clickstack_cloud_client_registration_failed",
        isRedirectResponse:
          response.status >= 300 && response.status < 400,
        redirectUri,
        status: response.status,
      }),
    );
    throw new ClickStackOAuthError("ClickStack client registration failed");
  }
  return clickStackRegistrationSchema.parse(await response.json()).client_id;
}

export function clickStackCloudAuthorizeUrl(input: {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL("/authorize", CLICKSTACK_CLOUD_OAUTH_ISSUER);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("resource", CLICKSTACK_CLOUD_OAUTH_RESOURCE);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "clickstack:access openid profile email");
  url.searchParams.set("state", input.state);
  return url.toString();
}

export async function exchangeClickStackCloudCode(input: {
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}) {
  const response = await fetch(`${CLICKSTACK_CLOUD_OAUTH_ISSUER}/token`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: input.clientId,
      code: input.code,
      code_verifier: input.codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: input.redirectUri,
      resource: CLICKSTACK_CLOUD_OAUTH_RESOURCE,
    }),
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    const errorPayload: unknown = await response.json().catch(() => null);
    const oauthError =
      errorPayload &&
      typeof errorPayload === "object" &&
      "error" in errorPayload &&
      typeof errorPayload.error === "string"
        ? errorPayload.error.slice(0, 100)
        : null;
    console.error(
      JSON.stringify({
        event: "clickstack_cloud_token_exchange_failed",
        oauthError,
        status: response.status,
      }),
    );
    throw new ClickStackOAuthError("ClickStack authorization failed");
  }
  return clickStackCloudTokenSchema.parse(await response.json());
}

export { CLICKSTACK_CLOUD_MCP_URL };

export async function clickStackAccount(input: {
  accessKey: string;
  mcpUrl: string;
}, fetchImpl: (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response> = safeCustomMcpFetch) {
  const mcpUrl = normalizeClickStackMcpUrl(input.mcpUrl);
  const response = await fetchImpl(clickStackTeamUrl(mcpUrl), {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${input.accessKey}`,
    },
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status === 401 || response.status === 403) {
    console.error(
      JSON.stringify({
        event: "clickstack_credentials_rejected",
        mcpUrl,
        status: response.status,
      }),
    );
    throw new ClickStackCredentialsError();
  }
  if (!response.ok) {
    console.error(
      JSON.stringify({
        event: "clickstack_team_lookup_failed",
        mcpUrl,
        status: response.status,
      }),
    );
    throw new Error("Unable to load the ClickStack team");
  }

  const payload = clickStackTeamSchema.parse(await response.json());
  console.info(
    JSON.stringify({
      event: "clickstack_team_validated",
      mcpUrl,
      teamId: payload.data.id,
    }),
  );
  return {
    externalAccountId: `${new URL(mcpUrl).origin}:${payload.data.id}`,
    displayName: payload.data.name,
    mcpUrl,
    teamId: payload.data.id,
  };
}
