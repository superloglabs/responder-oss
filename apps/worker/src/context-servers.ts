import type { FunctionTool, MCPServer, MCPToolFilterCallable, MCPToolFilterStatic } from "@openai/agents";
import {
  getRuntimeAwsConnections,
  getRuntimeAxiomConnection,
  getRuntimeClickStackConnection,
  getRuntimeCloudflareConnections,
  getRuntimeDash0Connections,
  getRuntimeDatadogConnection,
  getRuntimeGcpConnections,
  getRuntimeGrafanaConnections,
  getRuntimeLangfuseConnections,
  getRuntimeLinearConnection,
  getRuntimePostHogConnections,
  getRuntimeRailwayConnections,
  getRuntimeSentryConnection,
  getRuntimeSupabaseConnections,
  getRuntimeUpstashConnection,
  getRuntimeVercelConnections,
  type ContextConnectionLoadOptions,
} from "@responder/core/db/investigations";
import { supabaseMcpUrl } from "@responder/core/integrations/supabase";
import { createAwsMcpServer } from "./aws.js";
import { createAwsInspectionTools } from "./aws-inspection-tools.js";
import { createAxiomMcpServer } from "./axiom.js";
import { createClickStackMcpServer } from "./clickstack.js";
import { createCloudflareMcpServer } from "./cloudflare.js";
import { createLinearMcpServer } from "./custom-mcp.js";
import { createDash0McpServer } from "./dash0.js";
import { createDatadogMcpServer } from "./datadog.js";
import { createGcpMcpServers } from "./gcp.js";
import { createGrafanaMcpServer } from "./grafana.js";
import { createLangfuseMcpServer } from "./langfuse.js";
import { createPostHogMcpServer } from "./posthog.js";
import { createRailwayTools } from "./railway.js";
import { connectionSecrets, redactSecrets } from "./secret-safety.js";
import { createSentryMcpServer } from "./sentry.js";
import { createSupabaseMcpServer } from "./supabase.js";
import { createUpstashMcpServer } from "./upstash.js";
import { createVercelTools } from "./vercel.js";

export type ContextMcpTool = Awaited<ReturnType<MCPServer["listTools"]>>[number];

// Names that say a tool changes something. A tool that does not declare
// itself read-only is left out when its name says it writes.
const writeVerb = /(?:^|[_.\-\s])(?:create|update|delete|remove|edit|add|set|put|patch|post|write|mute|unmute|resolve|unresolve|assign|unassign|archive|unarchive|cancel|trigger|restart|redeploy|deploy|rollback|scale|enable|disable|install|uninstall|invite|link|unlink|merge|close|reopen|acknowledge|ack|snooze|silence|start|stop|pause|resume|apply|import|upload|send|notify|execute_sql|apply_migration)(?:$|[_.\-\s])/iu;

// A tool an observer may call: it declares itself read-only, or declares nothing
// and its name does not say it writes. A tool declared destructive or not
// read-only is never allowed.
export function isObservationTool(tool: ContextMcpTool): boolean {
  const annotations = (tool as { annotations?: { readOnlyHint?: unknown; destructiveHint?: unknown } }).annotations;
  if (annotations?.destructiveHint === true) return false;
  if (annotations?.readOnlyHint === true) return true;
  if (annotations?.readOnlyHint === false) return false;
  return !writeVerb.test(tool.name);
}

async function passesFilter(
  filter: MCPToolFilterCallable | MCPToolFilterStatic | undefined,
  serverName: string,
  tool: ContextMcpTool,
): Promise<boolean> {
  if (!filter) return true;
  if (typeof filter === "function") {
    // The provider filters read only the tool, so no run context is needed.
    return filter({ serverName } as Parameters<MCPToolFilterCallable>[0], tool);
  }
  const allowed = filter.allowedToolNames ?? [];
  const blocked = filter.blockedToolNames ?? [];
  return (allowed.length === 0 || allowed.includes(tool.name)) && !blocked.includes(tool.name);
}

// One provider connection's MCP server, with only the tools an observer may
// call. The Agents SDK applies a server's tool filter itself; a caller that
// lists tools directly gets them filtered here instead.
export class ObservationMcpServer {
  private tools: ContextMcpTool[] | null = null;
  unavailable: string | null = null;

  constructor(
    readonly server: MCPServer,
    private readonly describeError: (error: unknown) => string,
  ) {}

  get name(): string {
    return this.server.name;
  }

  async connect(): Promise<void> {
    try {
      await connectWithRetry(this.server);
    } catch (error) {
      this.unavailable = this.describeError(error);
    }
  }

  async listTools(): Promise<ContextMcpTool[]> {
    if (this.unavailable) return [];
    if (this.tools) return this.tools;
    try {
      const listed = await this.server.listTools();
      const kept: ContextMcpTool[] = [];
      for (const tool of listed) {
        if (await passesFilter(this.server.toolFilter, this.server.name, tool) && isObservationTool(tool)) kept.push(tool);
      }
      this.tools = kept;
      return kept;
    } catch (error) {
      this.unavailable = this.describeError(error);
      return [];
    }
  }

  async callTool(name: string, args: Record<string, unknown> | null) {
    const tools = await this.listTools();
    if (!tools.some((tool) => tool.name === name)) {
      throw new Error(`${name} is not available on ${this.name}`);
    }
    return this.server.callTool(name, args);
  }

  async close(): Promise<void> {
    await this.server.close().catch(() => undefined);
  }
}

const connectRetryDelaysMs = [0, 1_000, 3_000] as const;

// A brief network failure while connecting is retried; Node's fetch reports
// DNS, TLS, and socket failures as this TypeError.
async function connectWithRetry(server: MCPServer): Promise<void> {
  for (const [index, delayMs] of connectRetryDelaysMs.entries()) {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      await server.connect();
      return;
    } catch (error) {
      const network = error instanceof TypeError && error.message === "fetch failed";
      if (!network || index === connectRetryDelaysMs.length - 1) throw error;
    }
  }
}

// Datadog enables only its core tools unless asked for more. An observer
// gets every toolset, including APM, which is in preview.
export function datadogObservationUrl(mcpUrl: string): string {
  const url = new URL(mcpUrl);
  url.searchParams.set("toolsets", "all,apm");
  return url.toString();
}

export interface WorkspaceContext {
  servers: ObservationMcpServer[];
  // Provider tools that are not MCP servers, such as the CloudWatch helpers.
  tools: FunctionTool[];
  // Connections that could not be loaded, such as an expired grant.
  unavailable: string[];
  close(): Promise<void>;
}

// Every provider connection in a workspace, read-only, for a reader that
// investigates a workspace rather than running an automation.
// Custom MCP servers are left out, since they cannot promise read-only tools;
// Slack is left out, since the reader brings its own Slack search.
export async function openWorkspaceContext(input: {
  organizationId: string;
  // Names the reader in provider diagnostics, such as an investigation ID.
  label: string;
  environment?: NodeJS.ProcessEnv;
}): Promise<WorkspaceContext> {
  const environment = input.environment ?? process.env;
  const scope = { organizationId: input.organizationId };
  const unavailable: string[] = [];
  const options: ContextConnectionLoadOptions = {
    onUnavailable: (error) => unavailable.push(error.message),
  };
  const [
    aws, gcp, axiom, datadog, dash0, postHog, grafana, cloudflare, railway,
    sentry, clickStack, linear, vercel, upstash, langfuse, supabase,
  ] = await Promise.all([
    getRuntimeAwsConnections(scope),
    getRuntimeGcpConnections(scope),
    getRuntimeAxiomConnection(scope, options),
    getRuntimeDatadogConnection(scope),
    getRuntimeDash0Connections(scope, options),
    getRuntimePostHogConnections(scope, options),
    getRuntimeGrafanaConnections(scope, options),
    getRuntimeCloudflareConnections(scope, options),
    getRuntimeRailwayConnections(scope, options),
    getRuntimeSentryConnection(scope),
    getRuntimeClickStackConnection(scope),
    getRuntimeLinearConnection(scope, undefined, options),
    getRuntimeVercelConnections(scope),
    getRuntimeUpstashConnection(scope),
    getRuntimeLangfuseConnections(scope),
    getRuntimeSupabaseConnections(scope, options),
  ]);
  const secrets = connectionSecrets([
    ...aws, axiom, datadog, ...dash0, ...postHog, ...grafana, ...cloudflare, ...railway,
    sentry, clickStack, linear, ...vercel, upstash, ...langfuse, ...supabase,
  ]);
  const describeError = (error: unknown) =>
    redactSecrets(error instanceof Error ? error.message : String(error), secrets).slice(0, 1_000);

  const servers: MCPServer[] = [
    ...(await Promise.all(aws.map((connection) => createAwsMcpServer(connection, environment)))),
    ...gcp.flatMap((connection) => createGcpMcpServers(connection, environment)),
    ...(axiom ? [createAxiomMcpServer(axiom, { readOnly: true })] : []),
    ...(datadog ? [createDatadogMcpServer({ ...datadog, mcpUrl: datadogObservationUrl(datadog.mcpUrl) })] : []),
    ...dash0.map(createDash0McpServer),
    ...postHog.map(createPostHogMcpServer),
    ...(await Promise.all(grafana.map((connection) => createGrafanaMcpServer(connection, environment)))),
    ...cloudflare.map(createCloudflareMcpServer),
    ...(sentry ? [createSentryMcpServer(sentry, { investigationId: input.label })] : []),
    ...(clickStack ? [createClickStackMcpServer(clickStack)] : []),
    ...(linear ? [createLinearMcpServer(linear)] : []),
    ...(upstash ? [createUpstashMcpServer(upstash)] : []),
    ...langfuse.map(createLangfuseMcpServer),
    // Supabase connections that may write are opened read-only.
    ...supabase.map((connection) => createSupabaseMcpServer(
      connection.accessMode === "read_write"
        ? { ...connection, accessMode: "read_only" as const, mcpUrl: supabaseMcpUrl({ accessMode: "read_only", projectRef: connection.projectRef }) }
        : connection,
    )),
  ];
  const observed = servers.map((server) => new ObservationMcpServer(server, describeError));
  await Promise.all(observed.map((server) => server.connect()));

  const tools = [
    ...createAwsInspectionTools(aws, { environment }),
    ...createVercelTools(vercel),
    ...createRailwayTools(railway, { allowWrites: false }),
    // Each tool keeps its own input type; the reader calls them by JSON input.
  ] as unknown as FunctionTool[];

  return {
    servers: observed,
    tools,
    unavailable,
    close: async () => {
      await Promise.all(observed.map((server) => server.close()));
    },
  };
}
