import { startEgressProxy } from "./egress-proxy.js";

/**
 * Tool categories exposed by the self-hosted `mcp-grafana` process. Raw API,
 * SQL, rendering, snapshot, plugin, admin, provisioning, and assistant tools
 * stay disabled. `--disable-write` removes mutating tools inside these
 * categories and the read-only annotation rule below enforces it again.
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

/** Grafana tools are exposed only when the server annotates them read-only. */
export function isGrafanaReadOnlyTool(tool: unknown): boolean {
  const candidate = tool as {
    annotations?: { readOnlyHint?: unknown };
    name?: unknown;
  } | null;
  return (
    typeof candidate?.name === "string" &&
    candidate.annotations?.readOnlyHint === true
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
 * The `mcp-grafana` child reaches Grafana only through this process-local
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

/** How to start `mcp-grafana` for one self-hosted Grafana connection. */
export async function grafanaSelfHostedProcess(
  connection: { grafanaUrl: string; serviceAccountToken: string },
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ args: string[]; command: string; env: Record<string, string> }> {
  return {
    args: grafanaSelfHostedArgs(),
    command: environment.MCP_GRAFANA_BINARY || "mcp-grafana",
    env: {
      DO_NOT_TRACK: "1",
      GRAFANA_SERVICE_ACCOUNT_TOKEN: connection.serviceAccountToken,
      GRAFANA_SOCKS5_PROXY: await grafanaEgressProxyUrl(),
      GRAFANA_URL: connection.grafanaUrl,
    },
  };
}
