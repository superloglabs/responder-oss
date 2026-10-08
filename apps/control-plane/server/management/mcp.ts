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
import { jsonSchema } from "./openapi.js";
import type { ManagementContext, ManagementOperation } from "./operation.js";
import { managementOperations } from "./operations.js";

const instructions =
  "These tools read and change one Superlog workspace: automations and their runs, tag mode, model access, and workspace secrets. Call list_integrations before creating or changing an automation or tag mode, and use the IDs it returns. Make only the changes the user asks for, then say exactly what changed. Use list_available_integrations and start_integration_connection to give the person a consent link directly in chat. They approve access in their browser; afterward use list_integrations to verify connection and select resources. Never collect integration credentials in chat. Members, billing, new API keys, and secret values are managed in the app.";

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

export function createManagementMcpServer(context: ManagementContext): Server {
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
  const operations = new Map(
    mcpOperations.map((operation) => [operation.name, operation]),
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: mcpOperations.map(mcpTool),
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

// A stateless Streamable HTTP endpoint: each POST is handled by a new server
// for the API key or OAuth access token that sent it. The challenge points
// MCP clients to the OAuth metadata so they can sign the person in.
export const managementMcpRoutes = new Hono()
  .post("/", async (context) => {
    const caller = await authenticateManagementRequest(context.req.raw.headers, "mcp");
    if (!caller) {
      context.header("WWW-Authenticate", mcpWwwAuthenticate(controlPlaneBaseUrl()));
      return context.json(mcpUnauthorizedBody, 401);
    }
    const server = createManagementMcpServer(caller);
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(context.req.raw);
    } finally {
      await server.close().catch(() => undefined);
    }
  })
  .on(["GET", "DELETE"], "/", (context) => {
    context.header("Allow", "POST");
    return context.json(
      { error: "This MCP server is stateless. Send JSON-RPC messages with POST." },
      405,
    );
  });
