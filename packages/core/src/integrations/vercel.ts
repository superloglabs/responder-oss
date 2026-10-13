import { z } from "zod";
import catalog from "./generated/vercel-read-operations.json" with { type: "json" };

// Read-only access to Vercel's REST API: a generated catalog of safe GET
// operations and a request builder that keeps each call inside the
// installation's team and synchronized projects. Investigations call it from
// the worker and automations from the context broker.

/** The encrypted credentials of a Vercel installation connection. */
export const vercelCredentialsSchema = z.object({
  accessToken: z.string().min(1),
  configurationId: z.string().min(1),
  teamId: z.string().min(1).nullable(),
  userId: z.string().min(1).nullable(),
});

/** The installation token and the projects it may read. */
export interface VercelReadConnection {
  accessToken: string;
  projectIds: string[];
  teamId: string | null;
}

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

// These list projects, project settings, or integration configurations
// across the whole team and cannot be narrowed to the installation's projects.
const crossProjectListings = new Set([
  "getConfigurations",
  "getDomainProjectDomains",
  "getMicrofrontendsInGroup",
  "getObservabilityConfigurationProjects",
  "listAccessGroupProjects",
  "listNetworks",
  "listTeamFlagSettings",
  "listTeamFlags",
  "listTeamFlagsV2",
]);
const operations = (catalog.operations as ReadOperation[]).filter(
  (operation) => !crossProjectListings.has(operation.operationId),
);
/** Vercel's published OpenAPI document the catalog was generated from. */
export const vercelApiDocumentation = catalog.source;
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

function isProjectScopeParameter(
  operation: ReadOperation,
  name: string,
): boolean {
  return (
    /^(?:eligibleMembersForProjectId|excludeProject|project|projectId|projectIds|projectIdOrName)$/iu.test(name) ||
    operation.path.includes(`/projects/{${name}}`) ||
    (operation.tags.includes("projects") && name === "idOrName")
  );
}

function validateProjectScope(
  operation: ReadOperation,
  connection: VercelReadConnection,
  pathParameters: Record<string, ParameterValue>,
  queryParameters: Record<string, ParameterValue>,
): void {
  const projectParameters = [
    ...Object.entries(pathParameters),
    ...Object.entries(queryParameters),
  ].filter(([name]) =>
    isProjectScopeParameter(operation, name),
  );
  const projectIds = projectParameters.flatMap(([, value]) =>
    Array.isArray(value) ? value : [value],
  );
  // A listing that can be filtered by project otherwise spans the whole team.
  const isListing = !operation.parameters.some((parameter) => parameter.in === "path");
  const filtersByProject = operation.parameters.some((parameter) =>
    isProjectScopeParameter(operation, parameter.name),
  );
  if (isListing && filtersByProject && projectIds.length === 0) {
    throw new Error("Choose at least one selected Vercel project");
  }
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

function parameterValue(value: ParameterValue): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.map(String);
}

export function buildVercelReadUrl(input: {
  connection: VercelReadConnection;
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
    if (name === "slug") {
      throw new Error("Pass teamId instead of slug; the connection's team is applied automatically");
    }
    if (name === "teamId") {
      if (queryParameters.teamId !== (input.connection.teamId ?? undefined)) {
        throw new Error("The Vercel team is not available to this connection");
      }
      continue;
    }
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

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function validateDeploymentScope(input: {
  connection: VercelReadConnection;
  operation: ReadOperation;
  pathParameters: Record<string, ParameterValue>;
  signal?: AbortSignal;
}): Promise<void> {
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
    signal: requestSignal(input.signal),
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

// Project and team listings take no project filter, so their results are
// narrowed to what the installation shares.
const listingScopes: Record<string, {
  allowed: (connection: VercelReadConnection) => string[];
  field: string;
}> = {
  getProjects: { allowed: (connection) => connection.projectIds, field: "projects" },
  getTeams: {
    allowed: (connection) => (connection.teamId ? [connection.teamId] : []),
    field: "teams",
  },
};

function withinConnection(
  operation: ReadOperation,
  connection: VercelReadConnection,
  body: unknown,
): unknown {
  const scope = listingScopes[operation.operationId];
  if (!scope || !body || typeof body !== "object") return body;
  const items = (body as Record<string, unknown>)[scope.field];
  if (!Array.isArray(items)) return body;
  const allowed = new Set(scope.allowed(connection));
  return {
    ...body,
    [scope.field]: items.filter((item) =>
      item && typeof item === "object" && allowed.has((item as { id?: unknown }).id as string),
    ),
  };
}

export async function executeVercelRead(input: {
  connection: VercelReadConnection;
  operationId: string;
  pathParameters?: Record<string, ParameterValue>;
  queryParameters?: Record<string, ParameterValue>;
  signal?: AbortSignal;
}): Promise<string> {
  const operation = operationsById.get(input.operationId);
  if (!operation) throw new Error("Unknown or blocked Vercel read operation");
  const url = buildVercelReadUrl({ ...input, operation });
  await validateDeploymentScope({
    connection: input.connection,
    operation,
    pathParameters: input.pathParameters ?? {},
    signal: input.signal,
  });
  const response = await fetch(url, {
    headers: {
      accept: "application/json, text/plain;q=0.9",
      authorization: `Bearer ${input.connection.accessToken}`,
    },
    redirect: "error",
    signal: requestSignal(input.signal),
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
    data: sanitizeVercelValue(
      withinConnection(operation, input.connection, body),
      input.connection.accessToken,
    ),
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
export const vercelParameterEntrySchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("Exact parameter name returned by search_vercel_api"),
  value: parameterValueSchema.describe(
    "Parameter value using the type returned by search_vercel_api",
  ),
});

export function vercelParameterEntriesToRecord(
  entries: Array<z.infer<typeof vercelParameterEntrySchema>>,
  location: "path" | "query",
): Record<string, ParameterValue> {
  const parameters = Object.create(null) as Record<string, ParameterValue>;
  for (const { name, value } of entries) {
    if (Object.hasOwn(parameters, name)) {
      throw new Error(`Duplicate Vercel ${location} parameter: ${name}`);
    }
    parameters[name] = value;
  }
  return parameters;
}

export const vercelSearchToolDescription =
  "Search the read-only Vercel REST API catalog before making an API call. Secret, token, and environment-value operations are excluded.";
export const vercelCallToolDescription =
  "Execute one operation returned by search_vercel_api. Only generated GET operations are accepted.";

export const vercelSearchInputSchema = z.object({
  query: z.string().trim().max(500).default(""),
  limit: z.number().int().min(1).max(20).default(8),
});

export const vercelCallInputSchema = z.object({
  operationId: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("Exact operation ID returned by search_vercel_api"),
  pathParameters: z
    .array(vercelParameterEntrySchema)
    .max(30)
    .default([])
    .describe("Path parameters returned for the selected operation"),
  queryParameters: z
    .array(vercelParameterEntrySchema)
    .max(30)
    .default([])
    .describe("Query parameters returned for the selected operation"),
});

export function searchVercelApi(
  input: z.infer<typeof vercelSearchInputSchema>,
): string {
  return JSON.stringify({
    documentation: vercelApiDocumentation,
    operations: searchVercelOperations(input.query, input.limit),
  });
}

export async function callVercelApi(
  connection: VercelReadConnection,
  input: z.infer<typeof vercelCallInputSchema>,
  signal?: AbortSignal,
): Promise<string> {
  return executeVercelRead({
    connection,
    signal,
    operationId: input.operationId,
    pathParameters: vercelParameterEntriesToRecord(input.pathParameters, "path"),
    queryParameters: vercelParameterEntriesToRecord(input.queryParameters, "query"),
  });
}
