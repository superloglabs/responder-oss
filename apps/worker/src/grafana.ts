import {
  MCPServerStdio,
  MCPServerStreamableHttp,
  type MCPServer,
} from "@openai/agents";
import type { RuntimeGrafanaConnection } from "@responder/core/db/investigations";
import { safeCustomMcpFetch } from "@responder/core/integrations/custom-mcp";
import { startEgressProxy } from "./egress-proxy.js";

/**
 * Tool categories exposed by the self-hosted `mcp-grafana` process. Raw API,
 * SQL, rendering, snapshot, plugin, admin, provisioning, and assistant tools
 * stay disabled. `--disable-write` removes mutating tools inside these
 * categories and the read-only annotation filter below enforces it again.
 */
export const GRAFANA_SELF_HOSTED_TOOL_CATEGORIES = [
  "search",
  "datasource",
  "prometheus",
  "loki",
  "tempo",
  "pyroscope",
  "elasticsearch",
  "graphite",
  "cloudwatch",
  "alerting",
  "dashboard",
  "folder",
  "annotations",
  "incident",
  "oncall",
  "asserts",
  "sift",
  "navigation",
  "examples",
] as const;

export function grafanaReadOnlyToolFilter(
  _context: unknown,
  tool: unknown,
): Promise<boolean> {
  const candidate = tool as {
    annotations?: { readOnlyHint?: unknown };
    name?: unknown;
  };
  return Promise.resolve(
    typeof candidate.name === "string" &&
      candidate.annotations?.readOnlyHint === true,
  );
}

export function grafanaSelfHostedArgs(): string[] {
  return [
    "--disable-write",
    `--enabled-tools=${GRAFANA_SELF_HOSTED_TOOL_CATEGORIES.join(",")}`,
    "--usage-stats=disabled",
    "--log-level=warn",
  ];
}

let egressProxyUrl: Promise<string> | null = null;

/**
 * The `mcp-grafana` child reaches Grafana only through this worker-local
 * SOCKS5 proxy, which rejects private, link-local, and metadata addresses.
 */
function grafanaEgressProxyUrl(): Promise<string> {
  egressProxyUrl ??= startEgressProxy({
    allowLocal: process.env.NODE_ENV !== "production",
    name: "grafana",
  }).then((proxy) => {
    proxy.server.unref();
    return proxy.url;
  });
  egressProxyUrl.catch(() => {
    egressProxyUrl = null;
  });
  return egressProxyUrl;
}

export async function createGrafanaMcpServer(
  connection: RuntimeGrafanaConnection,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<MCPServer> {
  const name = `grafana-${connection.accountId}`;
  if (connection.authType === "oauth") {
    return new MCPServerStreamableHttp({
      cacheToolsList: true,
      clientSessionTimeoutSeconds: 300,
      fetch: safeCustomMcpFetch,
      name,
      requestInit: {
        headers: { authorization: `Bearer ${connection.accessToken}` },
      },
      timeout: 30_000,
      toolFilter: grafanaReadOnlyToolFilter,
      url: connection.mcpUrl,
      useStructuredContent: true,
    });
  }

  return new MCPServerStdio({
    args: grafanaSelfHostedArgs(),
    cacheToolsList: true,
    clientSessionTimeoutSeconds: 300,
    command: environment.MCP_GRAFANA_BINARY || "mcp-grafana",
    env: {
      DO_NOT_TRACK: "1",
      GRAFANA_SERVICE_ACCOUNT_TOKEN: connection.serviceAccountToken,
      GRAFANA_SOCKS5_PROXY: await grafanaEgressProxyUrl(),
      GRAFANA_URL: connection.grafanaUrl,
    },
    name,
    timeout: 30_000,
    toolFilter: grafanaReadOnlyToolFilter,
    useStructuredContent: true,
  });
}
