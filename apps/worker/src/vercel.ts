import { tool } from "@openai/agents";
import type { RuntimeVercelConnection } from "@responder/core/db/investigations";
import { z } from "zod";
import catalog from "./generated/vercel-read-operations.json" with { type: "json" };

const MAX_RESPONSE_BYTES = 250_000;
const REQUEST_TIMEOUT_MS = 30_000;
const REDACTED_KEY =
  /(?:authorization|cookie|credential|password|private[_-]?key|secret|token)/iu;
const REDACTED_CONTAINER_KEY =
  /^(?:buildEnv|env|envs|environmentVariables?|secrets?)$/iu;

type ParameterValue = string | number | boolean | Array<string | number | boolean>;
type OperationParameter = {
  name: string;
  in: "path" | "query";
  required: boolean;
  description?: string;
  schema: {
    type?: string;
    enum?: unknown[];
    minimum?: number;
    maximum?: number;
    items?: { type?: string };
  };
};
type ReadOperation = {
  operationId: string;
  path: string;
  summary: string;
  description?: string;
  tags: string[];
  parameters: OperationParameter[];
};

const operations = catalog.operations as ReadOperation[];
const operationsById = new Map(
  operations.map((operation) => [operation.operationId, operation]),
);
const deploymentScopeSchema = z.object({
  project: z.object({ id: z.string().min(1) }).optional(),
  projectId: z.string().min(1).optional(),
});

function searchTerms(query: string): string[] {
  return query
    .toLocaleLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((term) => term.length > 1);
}

export function searchVercelOperations(query: string, limit = 8) {
  const terms = searchTerms(query);
  return operations
    .map((operation) => {
      const haystack = [
        operation.operationId,
        operation.summary,
        operation.description ?? "",
        operation.path,
        ...operation.tags,
      ].join(" ").toLocaleLowerCase();
      const score = terms.reduce(
        (total, term) => total + (haystack.includes(term) ? 1 : 0),
        0,
      );
      return { operation, score };
    })
    .filter(({ score }) => terms.length === 0 || score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.operation.operationId.localeCompare(right.operation.operationId),
    )
    .slice(0, Math.min(Math.max(limit, 1), 20))
    .map(({ operation }) => operation);
}

function selectedConnection(
  connections: RuntimeVercelConnection[],
  accountId?: string,
): RuntimeVercelConnection {
  if (accountId) {
    const connection = connections.find((candidate) => candidate.accountId === accountId);
    if (!connection) throw new Error("Choose a connected Vercel account");
    return connection;
  }
  if (connections.length !== 1) {
    throw new Error("Specify accountId when more than one Vercel account is connected");
  }
  return connections[0]!;
}

function allowedParameterNames(operation: ReadOperation, location: "path" | "query") {
  return new Set(
    operation.parameters
      .filter((parameter) => parameter.in === location)
      .map((parameter) => parameter.name),
  );
}

function parameterMatchesType(value: unknown, type?: string): boolean {
  if (!type) return true;
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return true;
}

function validateParameter(parameter: OperationParameter, value: ParameterValue): void {
  if (parameter.schema.type === "array" && !Array.isArray(value)) {
    throw new Error(`Invalid Vercel parameter type: ${parameter.name}`);
  }
  if (parameter.schema.type !== "array" && Array.isArray(value)) {
    throw new Error(`Invalid Vercel parameter type: ${parameter.name}`);
  }
  const values = Array.isArray(value) ? value : [value];
  const expectedType = Array.isArray(value)
    ? parameter.schema.items?.type
    : parameter.schema.type;
  for (const item of values) {
    if (!parameterMatchesType(item, expectedType)) {
      throw new Error(`Invalid Vercel parameter type: ${parameter.name}`);
    }
    if (
      parameter.schema.enum &&
      !parameter.schema.enum.some((candidate) => candidate === item)
    ) {
      throw new Error(`Invalid Vercel parameter value: ${parameter.name}`);
    }
    if (
      typeof item === "number" &&
      parameter.schema.minimum !== undefined &&
      item < parameter.schema.minimum
    ) {
      throw new Error(`Vercel parameter is below its minimum: ${parameter.name}`);
    }
    if (
      typeof item === "number" &&
      parameter.schema.maximum !== undefined &&
      item > parameter.schema.maximum &&
      parameter.name !== "limit"
    ) {
      throw new Error(`Vercel parameter is above its maximum: ${parameter.name}`);
    }
  }
}

function validateProjectScope(
  operation: ReadOperation,
  connection: RuntimeVercelConnection,
  pathParameters: Record<string, ParameterValue>,
  queryParameters: Record<string, ParameterValue>,
): void {
  const projectParameters = [
    ...Object.entries(pathParameters),
    ...Object.entries(queryParameters),
  ].filter(([name]) =>
    /^(?:project|projectId|projectIds|projectIdOrName)$/iu.test(name) ||
    (operation.tags.includes("projects") && name === "idOrName"),
  );
  if (operation.operationId === "getDeployments" && projectParameters.length === 0) {
    throw new Error("Choose at least one selected Vercel project");
  }
  for (const [, value] of projectParameters) {
    const projectIds = Array.isArray(value) ? value : [value];
    if (
      projectIds.some(
        (projectId) =>
          typeof projectId !== "string" ||
          !connection.projectIds.includes(projectId),
      )
    ) {
      throw new Error("The Vercel project is not available to this connection");
    }
  }
}

function parameterValue(value: ParameterValue): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.map(String);
}

export function buildVercelReadUrl(input: {
  connection: RuntimeVercelConnection;
  operation: ReadOperation;
  pathParameters?: Record<string, ParameterValue>;
  queryParameters?: Record<string, ParameterValue>;
}): URL {
  const pathParameters = { ...(input.pathParameters ?? {}) };
  const queryParameters = input.queryParameters ?? {};
  const pathNames = allowedParameterNames(input.operation, "path");
  const queryNames = allowedParameterNames(input.operation, "query");

  for (const parameter of input.operation.parameters.filter(
    (candidate) => candidate.in === "path",
  )) {
    if (/^teamSlug$/iu.test(parameter.name)) {
      throw new Error("Vercel team-slug path operations are not available");
    }
    if (/^teamId$/iu.test(parameter.name)) {
      if (!input.connection.teamId) {
        throw new Error("This Vercel connection is not scoped to a team");
      }
      const supplied = pathParameters[parameter.name];
      if (supplied !== undefined && supplied !== input.connection.teamId) {
        throw new Error("The Vercel team is not available to this connection");
      }
      pathParameters[parameter.name] = input.connection.teamId;
    }
  }

  for (const name of Object.keys(pathParameters)) {
    if (!pathNames.has(name)) throw new Error(`Unknown Vercel path parameter: ${name}`);
  }
  for (const name of Object.keys(queryParameters)) {
    if (name === "teamId" || name === "slug") continue;
    if (!queryNames.has(name)) throw new Error(`Unknown Vercel query parameter: ${name}`);
  }
  for (const parameter of input.operation.parameters) {
    const supplied =
      parameter.in === "path"
        ? pathParameters[parameter.name]
        : queryParameters[parameter.name];
    if (supplied !== undefined) validateParameter(parameter, supplied);
    if (
      parameter.required &&
      supplied === undefined &&
      !["follow", "slug", "teamId"].includes(parameter.name)
    ) {
      throw new Error(`Missing Vercel ${parameter.in} parameter: ${parameter.name}`);
    }
  }

  let path = input.operation.path;
  for (const parameter of input.operation.parameters.filter(
    (candidate) => candidate.in === "path",
  )) {
    const value = pathParameters[parameter.name];
    if (value === undefined) {
      if (parameter.required) {
        throw new Error(`Missing Vercel path parameter: ${parameter.name}`);
      }
      continue;
    }
    if (Array.isArray(value)) {
      throw new Error(`Vercel path parameter ${parameter.name} must be a scalar`);
    }
    path = path.replace(`{${parameter.name}}`, encodeURIComponent(String(value)));
  }
  if (/\{[^}]+\}/u.test(path)) throw new Error("Missing a Vercel path parameter");
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error("Invalid Vercel API path");
  }

  validateProjectScope(
    input.operation,
    input.connection,
    pathParameters,
    queryParameters,
  );
  const url = new URL(path, "https://api.vercel.com");
  if (url.origin !== "https://api.vercel.com") {
    throw new Error("Invalid Vercel API origin");
  }
  for (const [name, rawValue] of Object.entries(queryParameters)) {
    if (name === "teamId" || name === "slug" || name === "follow") continue;
    for (let value of parameterValue(rawValue)) {
      if (name === "limit" && Number(value) > 100) value = "100";
      url.searchParams.append(name, value);
    }
  }
  if (queryNames.has("follow")) url.searchParams.set("follow", "0");
  if (input.connection.teamId && queryNames.has("teamId")) {
    url.searchParams.set("teamId", input.connection.teamId);
  }
  return url;
}

function deploymentIdentifier(
  operation: ReadOperation,
  pathParameters: Record<string, ParameterValue>,
): string | null {
  const entry = Object.entries(pathParameters).find(
    ([name, value]) =>
      typeof value === "string" &&
      (/^deploymentId$/iu.test(name) ||
        (operation.tags.includes("deployments") && /^(?:id|idOrUrl)$/iu.test(name))),
  );
  return typeof entry?.[1] === "string" ? entry[1] : null;
}

function hasProjectScopeParameter(
  operation: ReadOperation,
  pathParameters: Record<string, ParameterValue>,
  queryParameters: Record<string, ParameterValue>,
): boolean {
  return [...Object.keys(pathParameters), ...Object.keys(queryParameters)].some(
    (name) =>
      /^(?:project|projectId|projectIds|projectIdOrName)$/iu.test(name) ||
      (operation.tags.includes("projects") && name === "idOrName"),
  );
}

async function validateDeploymentScope(input: {
  connection: RuntimeVercelConnection;
  operation: ReadOperation;
  pathParameters: Record<string, ParameterValue>;
  queryParameters: Record<string, ParameterValue>;
}): Promise<void> {
  if (
    hasProjectScopeParameter(
      input.operation,
      input.pathParameters,
      input.queryParameters,
    )
  ) {
    return;
  }
  const deploymentId = deploymentIdentifier(
    input.operation,
    input.pathParameters,
  );
  if (!deploymentId) return;

  const url = new URL(
    `/v13/deployments/${encodeURIComponent(deploymentId)}`,
    "https://api.vercel.com",
  );
  if (input.connection.teamId) {
    url.searchParams.set("teamId", input.connection.teamId);
  }
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${input.connection.accessToken}`,
    },
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Unable to verify Vercel deployment scope (HTTP ${response.status})`);
  }
  const payload = deploymentScopeSchema.parse(
    JSON.parse(await boundedResponseText(response)) as unknown,
  );
  const projectId = payload.projectId ?? payload.project?.id;
  if (!projectId || !input.connection.projectIds.includes(projectId)) {
    throw new Error("The Vercel deployment is not available to this connection");
  }
}

function sanitizeVercelValue(value: unknown, accessToken: string): unknown {
  if (typeof value === "string") return value.replaceAll(accessToken, "[redacted]");
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeVercelValue(item, accessToken));
  }
  if (value && typeof value === "object") {
    const redactValueField =
      Object.hasOwn(value, "key") && Object.hasOwn(value, "value");
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        REDACTED_KEY.test(key) ||
        REDACTED_CONTAINER_KEY.test(key) ||
        (redactValueField && key === "value")
          ? "[redacted]"
          : sanitizeVercelValue(child, accessToken),
      ]),
    );
  }
  return value;
}

async function boundedResponseText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Vercel response exceeded the 250 KB safety limit");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

export async function executeVercelRead(input: {
  connection: RuntimeVercelConnection;
  operationId: string;
  pathParameters?: Record<string, ParameterValue>;
  queryParameters?: Record<string, ParameterValue>;
}): Promise<string> {
  const operation = operationsById.get(input.operationId);
  if (!operation) throw new Error("Unknown or blocked Vercel read operation");
  await validateDeploymentScope({
    connection: input.connection,
    operation,
    pathParameters: input.pathParameters ?? {},
    queryParameters: input.queryParameters ?? {},
  });
  const url = buildVercelReadUrl({ ...input, operation });
  const response = await fetch(url, {
    headers: {
      accept: "application/json, text/plain;q=0.9",
      authorization: `Bearer ${input.connection.accessToken}`,
    },
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json") && !contentType.startsWith("text/")) {
    throw new Error(`Vercel returned unsupported content type: ${contentType || "unknown"}`);
  }
  const text = await boundedResponseText(response);
  let body: unknown = text;
  if (contentType.includes("json") && text) {
    body = JSON.parse(text) as unknown;
  }
  const result = {
    operationId: operation.operationId,
    status: response.status,
    data: sanitizeVercelValue(body, input.connection.accessToken),
  };
  if (!response.ok) {
    throw new Error(`Vercel API returned HTTP ${response.status}: ${JSON.stringify(result.data)}`);
  }
  return JSON.stringify(result);
}

const parameterValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.union([z.string(), z.number(), z.boolean()])),
]);

export function createVercelTools(connections: RuntimeVercelConnection[]) {
  if (connections.length === 0) return [];
  const accountDescription = connections
    .map((connection) => `${connection.accountId}: ${connection.displayName}`)
    .join(", ");
  const searchVercelApi = tool({
    name: "search_vercel_api",
    description:
      "Search the read-only Vercel REST API catalog before making a Vercel API call. Secret, token, and environment-value operations are excluded.",
    parameters: z.object({
      query: z.string().trim().max(500).default(""),
      limit: z.number().int().min(1).max(20).default(8),
    }),
    async execute({ query, limit }) {
      return JSON.stringify({
        documentation: catalog.source,
        operations: searchVercelOperations(query, limit),
      });
    },
  });
  const callVercelApi = tool({
    name: "call_vercel_api",
    description: `Execute one operation returned by search_vercel_api. Only generated GET operations are accepted. Connected accounts: ${accountDescription}`,
    parameters: z.object({
      accountId: z.string().uuid().optional(),
      operationId: z.string().trim().min(1).max(200),
      pathParameters: z.record(z.string(), parameterValueSchema).default({}),
      queryParameters: z.record(z.string(), parameterValueSchema).default({}),
    }),
    async execute({ accountId, operationId, pathParameters, queryParameters }) {
      return executeVercelRead({
        connection: selectedConnection(connections, accountId),
        operationId,
        pathParameters,
        queryParameters,
      });
    },
  });
  return [searchVercelApi, callVercelApi];
}
