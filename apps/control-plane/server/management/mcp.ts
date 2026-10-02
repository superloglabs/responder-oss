import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { Hono } from "hono";
import {
  authenticateManagementRequest,
  executeOperation,
  unauthorizedBody,
} from "./execute.js";
import { jsonSchema } from "./openapi.js";
import type { ManagementContext, ManagementOperation } from "./operation.js";
import { managementOperations } from "./operations.js";

const instructions =
  "These tools read and change one Superlog workspace: automations and their runs, tag mode, model access, and workspace secrets. Call list_integrations before creating or changing an automation or tag mode, and use the IDs it returns. Make only the changes the user asks for, then say exactly what changed. Integrations are connected by a person in the Superlog app. Members, billing, new API keys, and secret values are managed in the app.";

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
      openWorldHint: false,
      readOnlyHint: operation.effect === "read",
      title: operation.summary,
    },
    description: operation.description,
    inputSchema: jsonSchema(operation.input, "input") as Tool["inputSchema"],
    name: operation.name,
    title: operation.summary,
  };
}

export function createManagementMcpServer(context: ManagementContext): Server {
  const server = new Server(
    { name: "superlog", title: "Superlog", version: "1.0.0" },
    { capabilities: { tools: {} }, instructions },
  );
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
        ...(result.status >= 400 ? { isError: true } : {}),
      };
    },
  );
  return server;
}

// A stateless Streamable HTTP endpoint: each POST is handled by a new server
// for the API key that sent it.
export const managementMcpRoutes = new Hono()
  .post("/", async (context) => {
    const caller = await authenticateManagementRequest(context.req.raw.headers, "mcp");
    if (!caller) {
      context.header("WWW-Authenticate", 'Bearer realm="superlog"');
      return context.json(unauthorizedBody, 401);
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
