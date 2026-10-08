import {
  AWS_MANAGED_MCP_ENDPOINT,
  type AwsConnectionCredentials,
  type AwsTemporaryCredentials,
} from "../../../../packages/core/src/integrations/aws.js";
import {
  AWS_MCP_REQUEST_TIMEOUT_MS,
  createAwsMcpFetch,
  createRefreshingAwsCredentialsProvider,
  isAwsReadOnlyMcpTool,
} from "../../../../packages/core/src/integrations/aws-mcp.js";
import type { ManagedMcpServer } from "./managed-mcp-context.js";

// Automation runs reach an AWS account through the same customer role and
// managed AWS MCP server as investigations, with the same tool filter. The
// broker signs each request, so the role session never reaches the run.

const MAX_CACHED_PROVIDERS = 200;

export interface AwsContextDependencies {
  credentials: (
    accountId: string,
    connection: AwsConnectionCredentials,
  ) => () => Promise<AwsTemporaryCredentials>;
  fetch: (input: string | URL, init: RequestInit) => Promise<Response>;
  now: () => number;
}

// The endpoint is fixed, so requests skip the custom MCP address checks. They
// get the same time limit as investigations.
export function awsContextFetch(input: string | URL, init: RequestInit): Promise<Response> {
  const timeout = AbortSignal.timeout(AWS_MCP_REQUEST_TIMEOUT_MS);
  return fetch(input, {
    ...init,
    signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
  });
}

const credentialProviders = new Map<string, () => Promise<AwsTemporaryCredentials>>();

/** Refreshing role credentials for one connection, shared across requests. */
export function awsContextCredentials(
  accountId: string,
  connection: AwsConnectionCredentials,
): () => Promise<AwsTemporaryCredentials> {
  const key = `${accountId}:${connection.roleArn}:${connection.externalId}`;
  let provider = credentialProviders.get(key);
  if (!provider) {
    provider = createRefreshingAwsCredentialsProvider({
      accountId,
      externalId: connection.externalId,
      roleArn: connection.roleArn,
    });
    credentialProviders.set(key, provider);
    if (credentialProviders.size > MAX_CACHED_PROVIDERS) {
      credentialProviders.delete(credentialProviders.keys().next().value!);
    }
  }
  return provider;
}

/** The managed AWS MCP server as the broker reaches it for a connection. */
export function awsContextServer(input: {
  accountId: string;
  connection: AwsConnectionCredentials;
  dependencies: AwsContextDependencies;
}): ManagedMcpServer {
  return {
    cacheKey: `aws:${input.accountId}:${input.connection.externalId}`,
    fetch: createAwsMcpFetch(
      input.dependencies.credentials(input.accountId, input.connection),
      input.dependencies.fetch,
    ),
    headers: async () => new Headers(),
    isAllowed: isAwsReadOnlyMcpTool,
    label: "AWS MCP",
    now: input.dependencies.now,
    url: AWS_MANAGED_MCP_ENDPOINT,
  };
}
