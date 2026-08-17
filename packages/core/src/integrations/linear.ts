import { createHash, randomBytes } from "node:crypto";
import type { IssueEvidence } from "../investigations/report.js";
import { z } from "zod";

export const LINEAR_MCP_URL = "https://mcp.linear.app/mcp";
export const LINEAR_READONLY_MCP_URL = "https://mcp.linear.app/mcp/readonly";
export const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
export const LINEAR_OAUTH_AUTHORIZE_URL = "https://linear.app/oauth/authorize";
export const LINEAR_OAUTH_TOKEN_URL = "https://api.linear.app/oauth/token";
export const LINEAR_AUTH_VERSION = "linear_oauth_v1";

const linearOAuthTokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1),
  scope: z.string().min(1),
  token_type: z.string().min(1),
});

export const linearOAuthCredentialsSchema = z.object({
  accessToken: z.string().min(1),
  authType: z.literal("linear_oauth"),
  expiresAt: z.number().int().positive(),
  mcpUrl: z.literal(LINEAR_MCP_URL),
  refreshToken: z.string().min(1),
  scope: z.string().min(1),
  tokenType: z.string().min(1),
});

export type LinearOAuthCredentials = z.infer<
  typeof linearOAuthCredentialsSchema
>;

export function parseLinearOAuthCredentials(
  input: unknown,
): LinearOAuthCredentials {
  return linearOAuthCredentialsSchema.parse(input);
}

function linearOAuthEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): { clientId: string; clientSecret: string } {
  const clientId = environment.LINEAR_CLIENT_ID;
  const clientSecret = environment.LINEAR_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Linear application credentials are not configured");
  }
  return { clientId, clientSecret };
}

export function createLinearPkce(): {
  codeChallenge: string;
  codeVerifier: string;
} {
  const codeVerifier = randomBytes(48).toString("base64url");
  const codeChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  return { codeChallenge, codeVerifier };
}

export function linearAuthorizeUrl(input: {
  codeChallenge: string;
  redirectUri: string;
  state: string;
}): string {
  const { clientId } = linearOAuthEnvironment();
  const url = new URL(LINEAR_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "read,write");
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

async function requestLinearOAuthToken(input: {
  fetchImpl?: typeof fetch;
  parameters: Record<string, string>;
}): Promise<LinearOAuthCredentials> {
  const { clientId, clientSecret } = linearOAuthEnvironment();
  const response = await (input.fetchImpl ?? fetch)(LINEAR_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      ...input.parameters,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Linear OAuth returned HTTP ${response.status}`);
  }
  const token = linearOAuthTokenSchema.parse(await response.json());
  return {
    accessToken: token.access_token,
    authType: "linear_oauth",
    expiresAt: Date.now() + token.expires_in * 1_000,
    mcpUrl: LINEAR_MCP_URL,
    refreshToken: token.refresh_token,
    scope: token.scope,
    tokenType: token.token_type,
  };
}

export function exchangeLinearOAuthCode(input: {
  authorizationCode: string;
  codeVerifier: string;
  fetchImpl?: typeof fetch;
  redirectUri: string;
}): Promise<LinearOAuthCredentials> {
  return requestLinearOAuthToken({
    fetchImpl: input.fetchImpl,
    parameters: {
      code: input.authorizationCode,
      code_verifier: input.codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: input.redirectUri,
    },
  });
}

export function linearAccessTokenNeedsRefresh(
  credentials: LinearOAuthCredentials,
  now = Date.now(),
): boolean {
  return credentials.expiresAt <= now + 60_000;
}

export function refreshLinearOAuthCredentials(input: {
  credentials: LinearOAuthCredentials;
  fetchImpl?: typeof fetch;
}): Promise<LinearOAuthCredentials> {
  return requestLinearOAuthToken({
    fetchImpl: input.fetchImpl,
    parameters: {
      grant_type: "refresh_token",
      refresh_token: input.credentials.refreshToken,
    },
  });
}

export interface LinearTicketIssue {
  id: string;
  title: string;
  description: string;
  severity: "SEV-1" | "SEV-2" | "SEV-3";
  remediation: string;
  evidence: IssueEvidence[];
}

function evidenceMarkdown(evidence: IssueEvidence[]): string {
  return evidence
    .map((item) => {
      const fileLocation = item.file
        ? `${item.file}${item.line ? `:${item.line}` : ""}`
        : null;
      return `- **${item.title}:** ${item.detail}${
        item.url
          ? ` ([source](${item.url}))`
          : fileLocation
            ? ` (${fileLocation})`
            : ""
      }`;
    })
    .join("\n");
}

export function renderLinearIssueDescription(input: {
  issue: LinearTicketIssue;
  issueBaseUrl: string;
  template: string;
}): string {
  const issueUrl = new URL(`/issues/${input.issue.id}`, input.issueBaseUrl).toString();
  const replacements: Record<string, string> = {
    issue_id: input.issue.id,
    issue_url: issueUrl,
    title: input.issue.title,
    description: input.issue.description,
    severity: input.issue.severity,
    evidence: evidenceMarkdown(input.issue.evidence),
    remediation: input.issue.remediation,
  };
  return input.template.replace(
    /{{(issue_id|issue_url|title|description|severity|evidence|remediation)}}/g,
    (_placeholder, key: keyof typeof replacements) => replacements[key],
  );
}

export interface PendingLinearTicketInstruction {
  requestId: string;
  issueId: string;
  title: string;
  description: string;
  severity: "SEV-1" | "SEV-2" | "SEV-3";
}

export function linearTicketFollowupInstruction(input: {
  requests: PendingLinearTicketInstruction[];
}): string | null {
  if (input.requests.length === 0) return null;
  return [
    "The report was saved and the Responder issue IDs below are now final.",
    "Before returning your final response, use the connected read-only Linear tools to inspect the available teams and projects. Choose the best matching team and project for each request, then call create_linear_ticket exactly once for each request ID.",
    "The create_linear_ticket tool owns the Linear write, applies the configured description template, and records the resulting Linear identifier and link.",
    JSON.stringify(input.requests),
  ].join("\n\n");
}

const linearIssueSchema = z.object({
  id: z.string().min(1),
  identifier: z.string().min(1),
  // This URL is persisted and later rendered as a clickable link. `z.url()`
  // also accepts executable schemes such as `javascript:`, so constrain the
  // upstream value before it reaches the UI.
  url: z.url().refine(
    (value) => new URL(value).protocol === "https:",
    "Linear issue URLs must use HTTPS",
  ),
});

const linearGraphqlResponseSchema = z.object({
  data: z.record(z.string(), z.unknown()).nullish(),
  errors: z.array(z.object({ message: z.string() }).passthrough()).optional(),
});

export interface CreatedLinearIssue {
  id: string;
  identifier: string;
  url: string;
}

async function linearGraphql(input: {
  accessToken: string;
  fetchImpl?: typeof fetch;
  query: string;
  variables: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const response = await (input.fetchImpl ?? fetch)(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query: input.query, variables: input.variables }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Linear API returned HTTP ${response.status}`);
  }
  const parsed = linearGraphqlResponseSchema.parse(await response.json());
  if (parsed.errors?.length) {
    throw new Error(parsed.errors.map((error) => error.message).join("; "));
  }
  return parsed.data ?? {};
}

export async function getLinearWorkspace(input: {
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<{ id: string; name: string }> {
  const data = await linearGraphql({
    ...input,
    query: `query ResponderLinearWorkspace {
      organization { id name }
    }`,
    variables: {},
  });
  return z.object({
    id: z.string().min(1),
    name: z.string().min(1),
  }).parse(data.organization);
}

export async function findLinearIssueById(input: {
  accessToken: string;
  fetchImpl?: typeof fetch;
  issueId: string;
}): Promise<CreatedLinearIssue | null> {
  const data = await linearGraphql({
    ...input,
    query: `query ResponderLinearIssue($id: String!) {
      issue(id: $id) { id identifier url }
    }`,
    variables: { id: input.issueId },
  });
  return data.issue ? linearIssueSchema.parse(data.issue) : null;
}

export async function createLinearIssue(input: {
  accessToken: string;
  description: string;
  fetchImpl?: typeof fetch;
  id: string;
  projectId?: string;
  teamId: string;
  title: string;
}): Promise<CreatedLinearIssue> {
  const data = await linearGraphql({
    ...input,
    query: `mutation ResponderCreateLinearIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { id identifier url }
      }
    }`,
    variables: {
      input: {
        description: input.description,
        id: input.id,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        teamId: input.teamId,
        title: input.title,
      },
    },
  });
  const payload = z.object({
    success: z.literal(true),
    issue: linearIssueSchema,
  }).parse(data.issueCreate);
  return payload.issue;
}
