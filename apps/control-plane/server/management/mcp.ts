import { connectionWidgetHtml, connectionWidgetUri } from "./connection-widget.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { Hono } from "hono";
import { controlPlaneBaseUrl } from "../integrations/urls.js";
import { mcpWwwAuthenticate } from "../mcp-oauth.js";
import {
  authenticateManagementRequest,
  executeOperation,
} from "./execute.js";
import {
  authenticateLegacyMcpForward,
  isLegacyMcpForward,
  legacyMcpForwardRefusedBody,
} from "./legacy-mcp-forward.js";
import { jsonSchema } from "./openapi.js";
import type { ManagementContext, ManagementOperation } from "./operation.js";
import { managementOperations } from "./operations.js";

const instructions =
  "These tools read and change one Superlog workspace: automations and their runs, tag mode, model access, and workspace secrets. They also read the workspace's logs, traces, and metrics, build dashboards and alerts over them, and run synthetic checks against URLs. To send telemetry from an app, create an ingest key with create_ingest_key and put the returned settings in the app's environment, never in a committed file. For telemetry, call list_services to find service names, start with a short window and filters, and follow a trace ID with get_trace. If a telemetry query times out, retry it with a shorter window or more filters. Error issues group the workspace's exceptions by fingerprint: start with list_error_issues, read one with get_error_issue, and follow its sample's trace ID with get_trace. When you work on an error issue, claim it with claim_error_issue first and skip issues someone else has claimed; post the root cause, progress, and the pull request with post_error_issue_update; and resolve it with update_error_issue once the fix is merged, or release it with release_error_issue if you stop. Workspace owners and admins can post new and regressed error issues to a Slack channel with update_error_notifications. Before adding a dashboard widget, query the data it will chart to check that the service, metric, and attribute names exist. To change a dashboard or widget, read it with get_dashboard first, since variables and widget config are replaced as a whole. Share the dashboard's url when you are done. Before creating an alert, check its rule and threshold with preview_alert. To post an alert, synthetic check, or error notifications to Slack, take the channel ID and integration ID from list_slack_channels. export_terraform returns Terraform configuration for alerts, dashboards, and synthetic checks. Call list_integrations before creating or changing an automation or tag mode, and use the repository, integration, and resource IDs it returns; secret IDs come from list_secrets. Make only the changes the user asks for, then say exactly what changed. To connect an integration, ask which integrations the person's goal needs, check list_available_integrations, and call start_integration_connection for one provider at a time. When the connection card is shown, don't repeat its link in your reply; without a card, show the exact returned URL as a link and never construct or shorten it. Consent links are personal: don't fetch, log, or share them. For OAuth integrations, the person approves access in their browser; for secure setup, they finish setup in Superlog. Afterward use list_integrations to verify the connection and select resources, and refresh_integrations to reload Slack channels or GitHub repositories. A started connection is not connected until list_integrations shows it. Never collect integration credentials in chat. Members, billing, new API keys, and secret values are managed in the app.";

// Operations that take a secret value are left out so it never passes
// through a model.
export const mcpOperations = managementOperations.filter(
  (operation) => operation.mcp !== false,
);

export function mcpTool(operation: ManagementOperation): Tool {
  return {
    annotations: {
      destructiveHint: operation.effect === "destructive",
      idempotentHint: operation.effect === "read",
      openWorldHint: operation.openWorld ?? false,
      readOnlyHint: operation.effect === "read",
      title: operation.summary,
    },
    description: operation.description,
    inputSchema: jsonSchema(operation.input, "input") as Tool["inputSchema"],
    name: operation.name,
    title: operation.summary,
    ...(operation.name === "start_integration_connection" ? { _meta: {
      ui: { resourceUri: connectionWidgetUri },
      "openai/outputTemplate": connectionWidgetUri,
      "openai/widgetAccessible": true,
    } } : operation.name === "list_integrations" ? { _meta: { "openai/widgetAccessible": true } } : {}),
  };
}

// A read-only caller sees and calls only the operations that change nothing.
export function createManagementMcpServer(
  context: ManagementContext,
  { readOnly = false }: { readOnly?: boolean } = {},
): Server {
  const server = new Server(
    { name: "superlog", title: "Superlog", version: "1.0.0", icons: [{ src: new URL("/superlog-silver-icon.png", controlPlaneBaseUrl()).href, mimeType: "image/png", sizes: ["1400x1400"] }] },
    { capabilities: { tools: {}, resources: {} }, instructions },
  );
  server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: [{
    uri: connectionWidgetUri, name: "Integration connection", mimeType: "text/html;profile=mcp-app",
  }] }));
  server.setRequestHandler(ReadResourceRequestSchema, (request) => {
    if (request.params.uri !== connectionWidgetUri) throw new Error("Unknown resource");
    return { contents: [{ uri: connectionWidgetUri, mimeType: "text/html;profile=mcp-app", text: connectionWidgetHtml.replace("__SUPERLOG_LOGO_URL__", new URL("/superlog-silver-icon.png", controlPlaneBaseUrl()).href),
      _meta: {
        ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [new URL(controlPlaneBaseUrl()).origin] } },
        "openai/ui": { availableDisplayModes: ["inline"], preferredDisplayMode: "inline" },
        "openai/widgetDescription": "A small integration consent card. It verifies connection and asks the conversation to continue after the user connects.",
        "openai/widgetCSP": { resource_domains: [new URL(controlPlaneBaseUrl()).origin], redirect_domains: [new URL(controlPlaneBaseUrl()).origin] },
      },
    }] };
  });
  const available = readOnly
    ? mcpOperations.filter((operation) => operation.effect === "read")
    : mcpOperations;
  const operations = new Map(
    available.map((operation) => [operation.name, operation]),
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: available.map(mcpTool),
  }));
  server.setRequestHandler(
    CallToolRequestSchema,
    async (request): Promise<CallToolResult> => {
      const operation = operations.get(request.params.name);
      if (!operation) {
        return {
          content: [{ text: `Unknown tool: ${request.params.name}`, type: "text" }],
          isError: true,
        };
      }
      const result = await executeOperation(
        operation,
        context,
        request.params.arguments ?? {},
      );
      return {
        content: [{ text: JSON.stringify(result.body), type: "text" }],
        ...(result.status < 400 ? { structuredContent: result.body } : {}),
        ...(result.status >= 400 ? { isError: true } : {}),
      };
    },
  );
  return server;
}

export const mcpUnauthorizedBody = {
  code: "unauthorized",
  error: "Connect with OAuth, or send a valid API key as `Authorization: Bearer <key>`. Create keys in Superlog under Settings → API keys.",
};

async function handleMcpRequest(
  request: Request,
  caller: ManagementContext,
  options: { readOnly?: boolean } = {},
): Promise<Response> {
  const server = createManagementMcpServer(caller, options);
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
    sessionIdGenerator: undefined,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close().catch(() => undefined);
  }
}

// A stateless Streamable HTTP endpoint: each POST is handled by a new server
// for the API key or OAuth access token that sent it. The challenge points
// MCP clients to the OAuth metadata so they can sign the person in. A request
// forwarded by the old product's MCP server is refused without a challenge,
// since signing in here would not fix it.
export const managementMcpRoutes = new Hono()
  .post("/", async (context) => {
    if (isLegacyMcpForward(context.req.raw.headers)) {
      const forwarded = await authenticateLegacyMcpForward(context.req.raw.headers);
      if (!forwarded) return context.json(legacyMcpForwardRefusedBody, 403);
      return handleMcpRequest(context.req.raw, forwarded.context, {
        readOnly: forwarded.readOnly,
      });
    }
    const caller = await authenticateManagementRequest(context.req.raw.headers, "mcp");
    if (!caller) {
      context.header("WWW-Authenticate", mcpWwwAuthenticate(controlPlaneBaseUrl()));
      return context.json(mcpUnauthorizedBody, 401);
    }
    return handleMcpRequest(context.req.raw, caller);
  })
  .on(["GET", "DELETE"], "/", (context) => {
    context.header("Allow", "POST");
    return context.json(
      { error: "This MCP server is stateless. Send JSON-RPC messages with POST." },
      405,
    );
  });
