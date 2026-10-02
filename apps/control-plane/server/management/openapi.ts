import { z } from "zod";
import { pathParameterNames, type ManagementOperation, type ManagementTag } from "./operation.js";
import { errorSchema } from "./schemas.js";

type JsonSchema = Record<string, unknown>;

const tagDescriptions: Record<ManagementTag, string> = {
  "API keys": "Keys that authenticate the management API and MCP server.",
  Automations: "Create and change automations.",
  Integrations: "Connected integrations and the IDs automations and tag mode use.",
  Models: "Model API keys, subscriptions, and available models.",
  Runs: "Start, follow, and cancel automation runs.",
  Secrets: "Credentials agents can use without seeing them.",
  "Tag mode": "What Superlog can use and change when someone mentions it in Slack.",
  Workspace: "The workspace and its members.",
};

// Format keywords already describe UUIDs and timestamps, and safe-integer
// bounds are implied, so they are left out to keep the schemas readable.
function simplify(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(simplify);
  if (!value || typeof value !== "object") return value;
  const schema = value as JsonSchema;
  const result: JsonSchema = {};
  for (const [key, entry] of Object.entries(schema)) {
    if (key === "$schema") continue;
    if (
      key === "pattern" &&
      (schema.format === "uuid" || schema.format === "date-time")
    ) {
      continue;
    }
    if (
      (key === "maximum" && entry === Number.MAX_SAFE_INTEGER) ||
      (key === "minimum" && entry === Number.MIN_SAFE_INTEGER)
    ) {
      continue;
    }
    result[key] = simplify(entry);
  }
  return result;
}

export function jsonSchema(
  schema: z.ZodType,
  io: "input" | "output",
): JsonSchema {
  return simplify(
    z.toJSONSchema(schema, { io, unrepresentable: "any" }),
  ) as JsonSchema;
}

// The operation's input without its path parameters, and without query
// parameters for a GET.
export function bodyFields(operation: ManagementOperation): z.ZodObject {
  const pathNames = new Set(pathParameterNames(operation.path));
  return z.object(
    Object.fromEntries(
      Object.entries(operation.input.shape).filter(([key]) => !pathNames.has(key)),
    ),
  );
}

function errorResponse(description: string) {
  return {
    content: {
      "application/json": { schema: { $ref: "#/components/schemas/Error" } },
    },
    description,
  };
}

function openApiOperation(operation: ManagementOperation) {
  const pathNames = pathParameterNames(operation.path);
  const shape = operation.input.shape as Record<string, z.ZodType>;
  const fields = bodyFields(operation);
  const fieldNames = Object.keys(fields.shape);
  const query = operation.method === "GET" || operation.method === "DELETE";
  const parameters = [
    ...pathNames.map((name) => {
      const schema = jsonSchema(shape[name]!, "input");
      return {
        description: schema.description,
        in: "path",
        name,
        required: true,
        schema,
      };
    }),
    ...(query
      ? fieldNames.map((name) => {
          const schema = jsonSchema(shape[name]!, "input");
          return {
            description: schema.description,
            in: "query",
            name,
            required: !shape[name]!.safeParse(undefined).success,
            schema,
          };
        })
      : []),
  ];
  return {
    description: operation.description,
    operationId: operation.name,
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(!query && fieldNames.length > 0
      ? {
          requestBody: {
            content: { "application/json": { schema: jsonSchema(fields, "input") } },
            required: !fields.safeParse({}).success,
          },
        }
      : {}),
    responses: {
      [String(operation.successStatus ?? 200)]: {
        content: {
          "application/json": { schema: jsonSchema(operation.output, "output") },
        },
        description: operation.successStatus === 202 ? "Accepted" : operation.successStatus === 201 ? "Created" : "OK",
      },
      ...(parameters.length > 0 || fieldNames.length > 0
        ? { "400": errorResponse("The request is invalid. `issues` lists each invalid field.") }
        : {}),
      "401": errorResponse("The API key is missing, revoked, or its creator left the workspace."),
      ...(pathNames.length > 0 || operation.requiresAutomations
        ? { "404": errorResponse("The resource does not exist in this workspace, or automations are not enabled.") }
        : {}),
      ...(operation.effect !== "read"
        ? { "409": errorResponse("The request conflicts with the current state, such as a name already in use.") }
        : {}),
    },
    security: [{ bearerAuth: [] }],
    summary: operation.summary,
    tags: [operation.tag],
    "x-mcp-tool": operation.mcp === false ? null : operation.name,
  };
}

export function buildOpenApiDocument(
  operations: ManagementOperation[],
  origin: string,
) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const operation of operations) {
    paths[operation.path] ??= {};
    paths[operation.path]![operation.method.toLowerCase()] = openApiOperation(operation);
  }
  const tags = [...new Set(operations.map((operation) => operation.tag))];
  return {
    components: {
      schemas: { Error: jsonSchema(errorSchema, "output") },
      securitySchemes: {
        bearerAuth: {
          description: "A workspace API key, created in Superlog under Settings → API keys.",
          scheme: "bearer",
          type: "http",
        },
      },
    },
    info: {
      description:
        "Manage a Superlog workspace's automations, runs, tag mode, model access, and secrets. Every request acts as the member who created the API key.",
      title: "Superlog management API",
      version: "1.0.0",
    },
    openapi: "3.1.0",
    paths,
    security: [{ bearerAuth: [] }],
    servers: [{ url: new URL("/api/v1", origin).toString() }],
    tags: tags.map((name) => ({ description: tagDescriptions[name], name })),
  };
}
