import { Sha256 } from "@aws-crypto/sha256-js";
import { MCPServerStreamableHttp } from "@openai/agents";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import type { RuntimeAwsConnection } from "@responder/core/db/investigations";
import {
  assumeAwsInvestigationRole,
  AWS_MANAGED_MCP_ENDPOINT,
  AWS_MCP_SIGNING_REGION,
} from "@responder/core/integrations/aws";

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

export function awsReadOnlyToolFilter(
  _context: unknown,
  tool: unknown,
): Promise<boolean> {
  const annotations = (tool as { annotations?: { readOnlyHint?: boolean } })
    .annotations;
  return Promise.resolve(annotations?.readOnlyHint === true);
}

export async function createAwsMcpServer(
  connection: RuntimeAwsConnection,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<MCPServerStreamableHttp> {
  const credentials = await assumeAwsInvestigationRole(
    {
      accountId: connection.roleArn.split(":")[4] ?? "",
      externalId: connection.externalId,
      roleArn: connection.roleArn,
    },
    { environment, sessionName: connection.accountId },
  );
  const signer = new SignatureV4({
    credentials,
    region: AWS_MCP_SIGNING_REGION,
    service: "aws-mcp",
    sha256: Sha256,
  });

  const signedFetch: typeof fetch = async (input, init) => {
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
    return fetch(url, {
      body,
      headers: signed.headers,
      method: request.method,
      redirect: request.redirect,
      signal: request.signal,
    });
  };

  return new MCPServerStreamableHttp({
    cacheToolsList: true,
    clientSessionTimeoutSeconds: 300,
    fetch: signedFetch,
    name: `aws-${connection.accountId}`,
    timeout: 60_000,
    toolFilter: awsReadOnlyToolFilter,
    url: AWS_MANAGED_MCP_ENDPOINT,
    useStructuredContent: true,
  });
}
