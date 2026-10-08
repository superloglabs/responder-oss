import { Sha256 } from "@aws-crypto/sha256-js";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import {
  assumeAwsInvestigationRole,
  AWS_MCP_SIGNING_REGION,
  type AwsTemporaryCredentials,
} from "./aws.js";

// Investigations and automation runs reach AWS's managed MCP server with the
// same read-only tool surface and the same customer role.

const AWS_CREDENTIAL_REFRESH_WINDOW_MS = 5 * 60 * 1_000;
export const AWS_MCP_REQUEST_TIMEOUT_MS = 60_000;
const AWS_MCP_IAM_GUARDED_TOOLS = new Set([
  "aws___get_tasks",
  "aws___run_script",
  // The managed server currently returns fully qualified names. Keep the raw
  // variants compatible with MCP clients that apply the namespace later.
  "get_tasks",
  "run_script",
]);

/**
 * Whether a managed AWS MCP tool may be exposed: tools annotated read-only,
 * plus the script runner and its task polling, which the read-only customer
 * role limits.
 */
export function isAwsReadOnlyMcpTool(tool: {
  annotations?: { readOnlyHint?: boolean };
  name?: string;
}): boolean {
  return tool.annotations?.readOnlyHint === true ||
    (tool.name !== undefined && AWS_MCP_IAM_GUARDED_TOOLS.has(tool.name));
}

// accountId is the Responder integration account. It names the role session.
export interface AwsRoleConnection {
  accountId: string;
  externalId: string;
  roleArn: string;
}

export function createRefreshingAwsCredentialsProvider(
  connection: AwsRoleConnection,
  environment: NodeJS.ProcessEnv = process.env,
  assume: typeof assumeAwsInvestigationRole = assumeAwsInvestigationRole,
  now: () => number = Date.now,
): () => Promise<AwsTemporaryCredentials> {
  let credentials: AwsTemporaryCredentials | null = null;
  let refresh: Promise<AwsTemporaryCredentials> | null = null;

  return async () => {
    if (
      credentials &&
      credentials.expiration.getTime() - AWS_CREDENTIAL_REFRESH_WINDOW_MS > now()
    ) {
      return credentials;
    }
    if (!refresh) {
      refresh = assume(
        {
          accountId: connection.roleArn.split(":")[4] ?? "",
          externalId: connection.externalId,
          roleArn: connection.roleArn,
        },
        { environment, sessionName: connection.accountId },
      )
        .then((next) => {
          credentials = next;
          return next;
        })
        .finally(() => {
          refresh = null;
        });
    }
    return refresh;
  };
}

function requestQuery(url: URL): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const [key, value] of url.searchParams) {
    const existing = query[key];
    query[key] = existing === undefined
      ? value
      : Array.isArray(existing)
        ? [...existing, value]
        : [existing, value];
  }
  return query;
}

/** A fetch that signs each request for the managed AWS MCP server. */
export function createAwsMcpFetch(
  credentials: () => Promise<AwsTemporaryCredentials>,
  baseFetch: (input: string | URL, init: RequestInit) => Promise<Response> = fetch,
): typeof fetch {
  const signer = new SignatureV4({
    credentials,
    region: AWS_MCP_SIGNING_REGION,
    service: "aws-mcp",
    sha256: Sha256,
  });

  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = request.method === "GET" || request.method === "HEAD"
      ? undefined
      : new Uint8Array(await request.clone().arrayBuffer());
    const signed = await signer.sign(
      new HttpRequest({
        body,
        headers: {
          ...Object.fromEntries(request.headers.entries()),
          host: url.host,
        },
        hostname: url.hostname,
        method: request.method,
        path: url.pathname,
        port: url.port ? Number(url.port) : undefined,
        protocol: url.protocol,
        query: requestQuery(url),
      }),
    );
    return baseFetch(url, {
      body,
      headers: signed.headers,
      method: request.method,
      redirect: request.redirect,
      signal: request.signal,
    });
  };
}
