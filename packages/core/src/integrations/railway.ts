import { z } from "zod";
import type { StoredCustomMcpOAuthState } from "./custom-mcp.js";

/**
 * Railway's API origin. It is both the OAuth authorization server and the
 * protected resource, so OAuth discovery starts here and tokens are issued
 * for this audience.
 */
export const RAILWAY_API_ORIGIN = "https://backboard.railway.com";
export const RAILWAY_GRAPHQL_URL = `${RAILWAY_API_ORIGIN}/graphql/v2`;

export const railwayAccessLevels = ["read_only", "redeploy"] as const;
export const railwayAccessLevelSchema = z.enum(railwayAccessLevels);
export type RailwayAccessLevel = z.infer<typeof railwayAccessLevelSchema>;

// Railway's consent screen asks the person which workspaces to share. Viewer
// access reads projects, deployments, logs, and metrics; member access can
// also redeploy and restart services.
const workspaceScope: Record<RailwayAccessLevel, string> = {
  read_only: "workspace:viewer",
  redeploy: "workspace:member",
};
const identityScopes = ["openid", "email", "profile", "offline_access"];

export function railwayOAuthScope(accessLevel: RailwayAccessLevel): string {
  return [...identityScopes, workspaceScope[accessLevel]].join(" ");
}

export class RailwayScopeError extends Error {
  constructor(readonly scopes: string[]) {
    super(
      scopes.length > 0
        ? `Railway granted scopes beyond the chosen access: ${scopes.join(", ")}`
        : "Railway did not report the granted scopes",
    );
    this.name = "RailwayScopeError";
  }
}

/**
 * Throws unless the grant stays within the chosen access level. A read-only
 * connection must not hold a scope that can change resources.
 */
export function assertRailwayGrant(
  tokens: StoredCustomMcpOAuthState["tokens"],
  accessLevel: RailwayAccessLevel,
): void {
  const scopes = typeof tokens?.scope === "string"
    ? tokens.scope.split(/\s+/u).filter(Boolean)
    : [];
  if (scopes.length === 0) throw new RailwayScopeError([]);
  const allowed = new Set([...identityScopes, "workspace:viewer", "project:viewer"]);
  if (accessLevel === "redeploy") allowed.add(workspaceScope.redeploy);
  const extra = scopes.filter((scope) => !allowed.has(scope));
  if (extra.length > 0) throw new RailwayScopeError(extra);
}

/**
 * OAuth lets a refresh response leave out `scope` when it is unchanged. The
 * scope checked when connecting then carries over, so the grant can still be
 * checked.
 */
export function withRailwayGrantScope(
  previous: StoredCustomMcpOAuthState,
  refreshed: StoredCustomMcpOAuthState,
): StoredCustomMcpOAuthState {
  if (
    refreshed === previous ||
    !refreshed.tokens ||
    refreshed.tokens.scope !== undefined ||
    previous.tokens?.scope === undefined
  ) {
    return refreshed;
  }
  return { ...refreshed, tokens: { ...refreshed.tokens, scope: previous.tokens.scope } };
}

export interface RailwayCredentials {
  accessLevel: RailwayAccessLevel;
  authType: "oauth";
  oauth: StoredCustomMcpOAuthState;
  /** When Railway issued the current access token, in epoch milliseconds. */
  tokenIssuedAt?: number;
}

const railwayCredentialsSchema = z.object({
  accessLevel: railwayAccessLevelSchema,
  authType: z.literal("oauth"),
  oauth: z.object({
    clientInformation: z.record(z.string(), z.unknown()).optional(),
    codeVerifier: z.string().min(1).optional(),
    discoveryState: z.record(z.string(), z.unknown()).optional(),
    tokens: z.record(z.string(), z.unknown()).optional(),
  }),
  tokenIssuedAt: z.number().int().nonnegative().optional(),
});

export function parseRailwayCredentials(input: unknown): RailwayCredentials {
  return railwayCredentialsSchema.parse(input) as RailwayCredentials;
}

// Railway access tokens last an hour. One with less than five minutes left
// is refreshed before use.
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

export function railwayAccessTokenIsFresh(
  credentials: RailwayCredentials,
  now: number,
): boolean {
  const expiresIn = credentials.oauth.tokens?.expires_in;
  if (!credentials.oauth.tokens?.access_token || credentials.tokenIssuedAt === undefined) {
    return false;
  }
  if (typeof expiresIn !== "number") return false;
  return now < credentials.tokenIssuedAt + expiresIn * 1000 - TOKEN_REFRESH_MARGIN_MS;
}

export interface RailwayWorkspace {
  id: string;
  name: string;
}

export const railwayWorkspacesSchema = z
  .array(z.object({ id: z.string().min(1), name: z.string() }))
  .max(50);

/**
 * The shared workspaces as the agent reads them. Workspace names come from
 * Railway and are quoted so a name cannot add instructions.
 */
export function railwayWorkspaceList(workspaces: readonly RailwayWorkspace[]): string {
  return workspaces
    .map((workspace) => `${JSON.stringify(workspace.name)} (workspaceId ${workspace.id})`)
    .join(", ");
}

/** A Railway connection as its tools use it. */
export interface RailwayToolConnection {
  accessLevel: RailwayAccessLevel;
  accessToken: string;
  workspaces: RailwayWorkspace[];
}

const MAX_RESPONSE_BYTES = 500_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_LOG_MESSAGE_CHARS = 4_000;

export type RailwayFetch = (input: string, init: RequestInit) => Promise<Response>;

const graphqlResponseSchema = z.object({
  data: z.unknown().optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

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
      throw new Error("Railway response exceeded the 500 KB safety limit; narrow the query");
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

/** Runs one fixed GraphQL operation against Railway's public API. */
export async function railwayGraphql<T>(input: {
  accessToken: string;
  fetch?: RailwayFetch;
  query: string;
  signal?: AbortSignal;
  variables?: Record<string, unknown>;
}): Promise<T> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const response = await (input.fetch ?? fetch)(RAILWAY_GRAPHQL_URL, {
    body: JSON.stringify({ query: input.query, variables: input.variables ?? {} }),
    headers: {
      accept: "application/json",
      authorization: `Bearer ${input.accessToken}`,
      "content-type": "application/json",
    },
    method: "POST",
    redirect: "error",
    signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
  });
  const text = await boundedResponseText(response);
  let payload: z.infer<typeof graphqlResponseSchema>;
  try {
    payload = graphqlResponseSchema.parse(JSON.parse(text) as unknown);
  } catch {
    throw new Error(`Railway API request failed (HTTP ${response.status})`);
  }
  if (payload.errors?.length) {
    const messages = payload.errors.map((error) => error.message.slice(0, 300)).join("; ");
    throw new Error(`Railway API error: ${messages}`);
  }
  if (!response.ok || payload.data === undefined || payload.data === null) {
    throw new Error(`Railway API request failed (HTTP ${response.status})`);
  }
  return payload.data as T;
}

const userinfoSchema = z.object({
  email: z.string().optional(),
  name: z.string().optional(),
  sub: z.string().min(1),
});

/** The Railway user who authorized the connection. */
export async function railwayUserinfo(
  accessToken: string,
  fetchFn: RailwayFetch = fetch,
): Promise<z.infer<typeof userinfoSchema>> {
  const response = await fetchFn(`${RAILWAY_API_ORIGIN}/oauth/me`, {
    headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Unable to read the Railway user (HTTP ${response.status})`);
  }
  return userinfoSchema.parse(JSON.parse(await boundedResponseText(response)) as unknown);
}

const workspaceListSchema = z.object({
  me: z.object({
    workspaces: z.array(z.object({ id: z.string(), name: z.string() })),
  }),
});

/**
 * The workspaces the person shared on Railway's consent screen. Railway lists
 * every workspace of the user, so each one is read to keep only those the
 * grant reaches.
 */
export async function railwaySharedWorkspaces(input: {
  accessToken: string;
  fetch?: RailwayFetch;
  signal?: AbortSignal;
}): Promise<RailwayWorkspace[]> {
  const listed = workspaceListSchema.parse(await railwayGraphql({
    ...input,
    query: "query { me { workspaces { id name } } }",
  }));
  const candidates = listed.me.workspaces.slice(0, 50);
  const reachable = await Promise.all(candidates.map(async (workspace) => {
    try {
      await railwayGraphql({
        ...input,
        query: "query ($workspaceId: String!) { workspace(workspaceId: $workspaceId) { id } }",
        variables: { workspaceId: workspace.id },
      });
      return workspace;
    } catch {
      return null;
    }
  }));
  return reachable.filter((workspace): workspace is RailwayWorkspace => workspace !== null);
}

// Tools. Every tool runs one fixed GraphQL operation; none takes a query
// from the agent. Environment variables and other secrets are never read.

const isoDate = z.string().datetime({ offset: true });

const deploymentStatuses = [
  "BUILDING",
  "CRASHED",
  "DEPLOYING",
  "FAILED",
  "INITIALIZING",
  "NEEDS_APPROVAL",
  "QUEUED",
  "REMOVED",
  "REMOVING",
  "SKIPPED",
  "SLEEPING",
  "SUCCESS",
  "WAITING",
] as const;

const resourceMeasurements = [
  "CPU_USAGE",
  "CPU_LIMIT",
  "MEMORY_USAGE_GB",
  "MEMORY_LIMIT_GB",
  "NETWORK_RX_GB",
  "NETWORK_TX_GB",
  "DISK_USAGE_GB",
  "EPHEMERAL_DISK_USAGE_GB",
] as const;

const logFilterDescription =
  "Optional Railway log filter, for example `@level:error`, `\"timeout\"`, or `@service:<serviceId>`. Combine terms with AND, OR, and -.";

export const railwayToolInputSchemas = {
  get_railway_deployment_logs: z.object({
    deploymentId: z.string().min(1).max(100),
    endDate: isoDate.optional().describe("ISO 8601 end of the window"),
    filter: z.string().max(500).optional().describe(logFilterDescription),
    kind: z.enum(["deploy", "build"]).default("deploy")
      .describe("deploy for runtime logs, build for build logs"),
    limit: z.number().int().min(1).max(1000).default(200),
    startDate: isoDate.optional().describe("ISO 8601 start of the window"),
  }),
  get_railway_environment_logs: z.object({
    endDate: isoDate.optional().describe("ISO 8601 time to read back from; defaults to now"),
    environmentId: z.string().min(1).max(100),
    filter: z.string().max(500).optional().describe(logFilterDescription),
    limit: z.number().int().min(1).max(1000).default(200),
  }),
  get_railway_http_logs: z.object({
    deploymentId: z.string().min(1).max(100),
    endDate: isoDate.optional().describe("ISO 8601 time to read back from; defaults to now"),
    filter: z.string().max(500).optional()
      .describe("Optional filter, for example `@httpStatus:>=500` or `@path:/api`"),
    limit: z.number().int().min(1).max(1000).default(200),
  }),
  get_railway_http_metrics: z.object({
    endDate: isoDate.optional().describe("ISO 8601 end; defaults to now"),
    environmentId: z.string().min(1).max(100),
    method: z.string().max(10).optional(),
    path: z.string().max(500).optional(),
    serviceId: z.string().min(1).max(100),
    startDate: isoDate.describe("ISO 8601 start"),
    stepSeconds: z.number().int().min(60).max(86_400).optional(),
  }),
  get_railway_metrics: z.object({
    endDate: isoDate.optional().describe("ISO 8601 end; defaults to now"),
    environmentId: z.string().min(1).max(100),
    measurements: z.array(z.enum(resourceMeasurements)).min(1).max(8)
      .default(["CPU_USAGE", "MEMORY_USAGE_GB"]),
    sampleRateSeconds: z.number().int().min(30).max(86_400).optional(),
    serviceId: z.string().min(1).max(100),
    startDate: isoDate.describe("ISO 8601 start"),
  }),
  list_railway_deployments: z.object({
    environmentId: z.string().min(1).max(100).optional(),
    limit: z.number().int().min(1).max(50).default(10),
    projectId: z.string().min(1).max(100),
    serviceId: z.string().min(1).max(100).optional(),
    statuses: z.array(z.enum(deploymentStatuses)).max(13).optional(),
  }),
  list_railway_projects: z.object({
    workspaceId: z.string().min(1).max(100).optional()
      .describe("Limit the listing to one shared workspace"),
  }),
  redeploy_railway_deployment: z.object({
    deploymentId: z.string().min(1).max(100)
      .describe("The deployment to rebuild and deploy again"),
  }),
  restart_railway_deployment: z.object({
    deploymentId: z.string().min(1).max(100)
      .describe("The running deployment to restart without rebuilding"),
  }),
} as const;

export type RailwayToolName = keyof typeof railwayToolInputSchemas;

export const railwayReadToolNames = [
  "list_railway_projects",
  "list_railway_deployments",
  "get_railway_deployment_logs",
  "get_railway_environment_logs",
  "get_railway_http_logs",
  "get_railway_metrics",
  "get_railway_http_metrics",
] as const satisfies readonly RailwayToolName[];

export const railwayWriteToolNames = [
  "redeploy_railway_deployment",
  "restart_railway_deployment",
] as const satisfies readonly RailwayToolName[];

export const railwayToolDescriptions: Record<RailwayToolName, string> = {
  get_railway_deployment_logs:
    "Read runtime or build logs of one Railway deployment, newest last. Bound the window with startDate and endDate when you can.",
  get_railway_environment_logs:
    "Read recent logs across every service in a Railway environment, newest last. Use a filter to narrow by service, level, or text.",
  get_railway_http_logs:
    "Read recent HTTP request logs of one Railway deployment: method, path, status, durations, and upstream errors.",
  get_railway_http_metrics:
    "Read request counts per HTTP status over time for a Railway service in one environment.",
  get_railway_metrics:
    "Read CPU, memory, network, and disk metrics over time for a Railway service in one environment. CPU is in vCPUs; memory, network, and disk are in GB.",
  list_railway_deployments:
    "List recent deployments of a Railway project, newest first, with status, commit, and creation time. Narrow by environment, service, or status.",
  list_railway_projects:
    "List the shared Railway workspaces' projects with their environments, services, and each service's latest deployment and status. Call this first to find IDs.",
  redeploy_railway_deployment:
    "Rebuild and deploy a Railway deployment again. This changes production. Call it only when the person or your instructions ask for a redeploy, and say what you redeployed.",
  restart_railway_deployment:
    "Restart a running Railway deployment without rebuilding it. This changes production. Call it only when the person or your instructions ask for a restart, and say what you restarted.",
};

export function isRailwayWriteTool(name: string): boolean {
  return (railwayWriteToolNames as readonly string[]).includes(name);
}

/** The tool names a connection offers, given whether the run may change things. */
export function railwayToolNames(
  connection: Pick<RailwayToolConnection, "accessLevel">,
  allowWrites: boolean,
): RailwayToolName[] {
  return allowWrites && connection.accessLevel === "redeploy"
    ? [...railwayReadToolNames, ...railwayWriteToolNames]
    : [...railwayReadToolNames];
}

interface Connection<T> {
  edges: Array<{ node: T }>;
}

function nodes<T>(connection: Connection<T> | null | undefined): T[] {
  return connection?.edges.map((edge) => edge.node) ?? [];
}

const deploymentFields = `
  id
  status
  createdAt
  statusUpdatedAt
  serviceId
  environmentId
  staticUrl
  canRedeploy
  canRollback
  meta
  service { name }
  environment { name }
`;

interface RailwayDeployment {
  canRedeploy?: boolean;
  canRollback?: boolean;
  createdAt: string;
  environment?: { name: string } | null;
  environmentId?: string | null;
  id: string;
  meta?: Record<string, unknown> | null;
  service?: { name: string } | null;
  serviceId?: string | null;
  staticUrl?: string | null;
  status: string;
  statusUpdatedAt?: string | null;
}

// Deployment metadata can carry the full build configuration; only fields
// that describe what was deployed are kept.
const deploymentMetaKeys = [
  "branch",
  "commitAuthor",
  "commitHash",
  "commitMessage",
  "image",
  "reason",
  "repo",
  "rootDirectory",
];

function compactDeployment(deployment: RailwayDeployment) {
  const meta = deployment.meta && typeof deployment.meta === "object"
    ? Object.fromEntries(
        deploymentMetaKeys
          .filter((key) => deployment.meta?.[key] !== undefined && deployment.meta?.[key] !== null)
          .map((key) => [key, deployment.meta?.[key]]),
      )
    : {};
  return {
    canRedeploy: deployment.canRedeploy,
    canRollback: deployment.canRollback,
    createdAt: deployment.createdAt,
    environment: deployment.environment?.name,
    environmentId: deployment.environmentId,
    id: deployment.id,
    ...(Object.keys(meta).length > 0 ? { meta } : {}),
    service: deployment.service?.name,
    serviceId: deployment.serviceId,
    status: deployment.status,
    statusUpdatedAt: deployment.statusUpdatedAt,
    ...(deployment.staticUrl ? { url: `https://${deployment.staticUrl}` } : {}),
  };
}

interface RailwayLog {
  attributes?: Array<{ key: string; value: string }>;
  message: string;
  severity?: string | null;
  tags?: { deploymentId?: string | null; serviceId?: string | null } | null;
  timestamp: string;
}

function compactLogs(logs: RailwayLog[], options: { startDate?: string } = {}) {
  const start = options.startDate ? Date.parse(options.startDate) : null;
  return logs
    .filter((log) => start === null || Date.parse(log.timestamp) >= start)
    .map((log) => ({
      timestamp: log.timestamp,
      ...(log.severity ? { severity: log.severity } : {}),
      message: log.message.length > MAX_LOG_MESSAGE_CHARS
        ? `${log.message.slice(0, MAX_LOG_MESSAGE_CHARS)}…`
        : log.message,
      ...(log.attributes?.length
        ? { attributes: Object.fromEntries(log.attributes.map((attribute) => [attribute.key, attribute.value])) }
        : {}),
      ...(log.tags?.serviceId ? { serviceId: log.tags.serviceId } : {}),
      ...(log.tags?.deploymentId ? { deploymentId: log.tags.deploymentId } : {}),
    }));
}

const logFields = "timestamp severity message attributes { key value } tags { serviceId deploymentId }";

// A connection made when its workspaces could not be listed reads them now.
async function workspacesFor(
  connection: RailwayToolConnection,
  options: RailwayCallOptions,
  workspaceId?: string,
): Promise<RailwayWorkspace[]> {
  const workspaces = connection.workspaces.length > 0
    ? connection.workspaces
    : await railwaySharedWorkspaces({ ...options, accessToken: connection.accessToken });
  if (!workspaceId) return workspaces;
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) throw new Error("Choose a workspace this Railway connection shares");
  return [workspace];
}

type ProjectNode = {
  environments: Connection<{
    id: string;
    name: string;
    serviceInstances: Connection<{
      latestDeployment: RailwayDeployment | null;
      serviceId: string;
      serviceName: string;
    }>;
  }>;
  id: string;
  name: string;
  services: Connection<{ id: string; name: string }>;
};

const listProjectsQuery = `query ($workspaceId: String!) {
  workspace(workspaceId: $workspaceId) {
    projects(first: 50) {
      edges { node {
        id
        name
        services(first: 100) { edges { node { id name } } }
        environments(first: 20) { edges { node {
          id
          name
          serviceInstances(first: 100) { edges { node {
            serviceId
            serviceName
            latestDeployment { id status createdAt }
          } } }
        } } }
      } }
    }
  }
}`;

async function listProjects(
  connection: RailwayToolConnection,
  args: z.infer<typeof railwayToolInputSchemas.list_railway_projects>,
  options: RailwayCallOptions,
) {
  const workspaces = await workspacesFor(connection, options, args.workspaceId);
  return Promise.all(workspaces.map(async (workspace) => {
    const data = await railwayGraphql<{ workspace: { projects: Connection<ProjectNode> } }>({
      ...options,
      accessToken: connection.accessToken,
      query: listProjectsQuery,
      variables: { workspaceId: workspace.id },
    });
    return {
      id: workspace.id,
      name: workspace.name,
      projects: nodes(data.workspace.projects).map((project) => ({
        environments: nodes(project.environments).map((environment) => ({
          id: environment.id,
          name: environment.name,
          services: nodes(environment.serviceInstances).map((instance) => ({
            latestDeployment: instance.latestDeployment
              ? {
                  createdAt: instance.latestDeployment.createdAt,
                  id: instance.latestDeployment.id,
                  status: instance.latestDeployment.status,
                }
              : null,
            name: instance.serviceName,
            serviceId: instance.serviceId,
          })),
        })),
        id: project.id,
        name: project.name,
        services: nodes(project.services),
      })),
    };
  }));
}

export interface RailwayCallOptions {
  fetch?: RailwayFetch;
  signal?: AbortSignal;
}

type ToolHandler = (
  connection: RailwayToolConnection,
  args: unknown,
  options: RailwayCallOptions,
) => Promise<unknown>;

function graphql<T>(
  connection: RailwayToolConnection,
  options: RailwayCallOptions,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  return railwayGraphql<T>({ ...options, accessToken: connection.accessToken, query, variables });
}

const handlers: Record<RailwayToolName, ToolHandler> = {
  list_railway_projects: (connection, args, options) =>
    listProjects(connection, railwayToolInputSchemas.list_railway_projects.parse(args), options)
      .then((workspaces) => ({ workspaces })),

  list_railway_deployments: async (connection, rawArgs, options) => {
    const args = railwayToolInputSchemas.list_railway_deployments.parse(rawArgs);
    const data = await graphql<{ deployments: Connection<RailwayDeployment> }>(
      connection,
      options,
      `query ($input: DeploymentListInput!, $first: Int!) {
        deployments(input: $input, first: $first) { edges { node { ${deploymentFields} } } }
      }`,
      {
        first: args.limit,
        input: {
          projectId: args.projectId,
          ...(args.environmentId ? { environmentId: args.environmentId } : {}),
          ...(args.serviceId ? { serviceId: args.serviceId } : {}),
          ...(args.statuses?.length ? { status: { in: args.statuses } } : {}),
        },
      },
    );
    return { deployments: nodes(data.deployments).map(compactDeployment) };
  },

  get_railway_deployment_logs: async (connection, rawArgs, options) => {
    const args = railwayToolInputSchemas.get_railway_deployment_logs.parse(rawArgs);
    const field = args.kind === "build" ? "buildLogs" : "deploymentLogs";
    const data = await graphql<Record<string, RailwayLog[]>>(
      connection,
      options,
      `query ($deploymentId: String!, $limit: Int, $filter: String, $startDate: DateTime, $endDate: DateTime) {
        logs: ${field}(deploymentId: $deploymentId, limit: $limit, filter: $filter, startDate: $startDate, endDate: $endDate) { ${logFields} }
      }`,
      {
        deploymentId: args.deploymentId,
        endDate: args.endDate ?? null,
        filter: args.filter ?? null,
        limit: args.limit,
        startDate: args.startDate ?? null,
      },
    );
    return { logs: compactLogs(data.logs ?? []) };
  },

  get_railway_environment_logs: async (connection, rawArgs, options) => {
    const args = railwayToolInputSchemas.get_railway_environment_logs.parse(rawArgs);
    const data = await graphql<{ logs: RailwayLog[] }>(
      connection,
      options,
      `query ($environmentId: String!, $filter: String, $beforeDate: String, $beforeLimit: Int) {
        logs: environmentLogs(environmentId: $environmentId, filter: $filter, beforeDate: $beforeDate, beforeLimit: $beforeLimit) { ${logFields} }
      }`,
      {
        beforeDate: args.endDate ?? new Date().toISOString(),
        beforeLimit: args.limit,
        environmentId: args.environmentId,
        filter: args.filter ?? null,
      },
    );
    return { logs: compactLogs(data.logs ?? []) };
  },

  get_railway_http_logs: async (connection, rawArgs, options) => {
    const args = railwayToolInputSchemas.get_railway_http_logs.parse(rawArgs);
    const data = await graphql<{ logs: Array<Record<string, unknown>> }>(
      connection,
      options,
      `query ($deploymentId: String!, $filter: String, $beforeDate: String, $beforeLimit: Int) {
        logs: httpLogs(deploymentId: $deploymentId, filter: $filter, beforeDate: $beforeDate, beforeLimit: $beforeLimit) {
          timestamp requestId method host path httpStatus totalDuration upstreamRqDuration
          upstreamErrors responseDetails edgeRegion deploymentInstanceId
        }
      }`,
      {
        beforeDate: args.endDate ?? new Date().toISOString(),
        beforeLimit: args.limit,
        deploymentId: args.deploymentId,
        filter: args.filter ?? null,
      },
    );
    return { logs: data.logs ?? [] };
  },

  get_railway_metrics: async (connection, rawArgs, options) => {
    const args = railwayToolInputSchemas.get_railway_metrics.parse(rawArgs);
    const data = await graphql<{
      metrics: Array<{ measurement: string; values: Array<{ ts: number; value: number }> }>;
    }>(
      connection,
      options,
      `query ($serviceId: String!, $environmentId: String!, $measurements: [MetricMeasurement!]!, $startDate: DateTime!, $endDate: DateTime, $sampleRateSeconds: Int) {
        metrics(serviceId: $serviceId, environmentId: $environmentId, measurements: $measurements, startDate: $startDate, endDate: $endDate, sampleRateSeconds: $sampleRateSeconds) {
          measurement
          values { ts value }
        }
      }`,
      {
        endDate: args.endDate ?? null,
        environmentId: args.environmentId,
        measurements: args.measurements,
        sampleRateSeconds: args.sampleRateSeconds ?? null,
        serviceId: args.serviceId,
        startDate: args.startDate,
      },
    );
    return {
      metrics: data.metrics.map((metric) => ({
        measurement: metric.measurement,
        values: metric.values.map((value) => [new Date(value.ts * 1000).toISOString(), value.value]),
      })),
    };
  },

  get_railway_http_metrics: async (connection, rawArgs, options) => {
    const args = railwayToolInputSchemas.get_railway_http_metrics.parse(rawArgs);
    const data = await graphql<{
      metrics: Array<{ samples: Array<{ ts: number; value: number }>; statusCode: number }>;
    }>(
      connection,
      options,
      `query ($serviceId: String!, $environmentId: String!, $startDate: DateTime!, $endDate: DateTime!, $stepSeconds: Int, $method: String, $path: String) {
        metrics: httpMetricsGroupedByStatus(serviceId: $serviceId, environmentId: $environmentId, startDate: $startDate, endDate: $endDate, stepSeconds: $stepSeconds, method: $method, path: $path) {
          statusCode
          samples { ts value }
        }
      }`,
      {
        endDate: args.endDate ?? new Date().toISOString(),
        environmentId: args.environmentId,
        method: args.method ?? null,
        path: args.path ?? null,
        serviceId: args.serviceId,
        startDate: args.startDate,
        stepSeconds: args.stepSeconds ?? null,
      },
    );
    return {
      statuses: data.metrics.map((metric) => ({
        samples: metric.samples.map((sample) => [new Date(sample.ts * 1000).toISOString(), sample.value]),
        statusCode: metric.statusCode,
      })),
    };
  },

  redeploy_railway_deployment: async (connection, rawArgs, options) => {
    const args = railwayToolInputSchemas.redeploy_railway_deployment.parse(rawArgs);
    const data = await graphql<{ deploymentRedeploy: RailwayDeployment }>(
      connection,
      options,
      `mutation ($id: String!) { deploymentRedeploy(id: $id) { ${deploymentFields} } }`,
      { id: args.deploymentId },
    );
    return { redeployed: args.deploymentId, deployment: compactDeployment(data.deploymentRedeploy) };
  },

  restart_railway_deployment: async (connection, rawArgs, options) => {
    const args = railwayToolInputSchemas.restart_railway_deployment.parse(rawArgs);
    const data = await graphql<{ deploymentRestart: boolean }>(
      connection,
      options,
      "mutation ($id: String!) { deploymentRestart(id: $id) }",
      { id: args.deploymentId },
    );
    return { restarted: data.deploymentRestart ? args.deploymentId : null };
  },
};

/**
 * Runs one Railway tool and returns its JSON text. Write tools run only when
 * the caller allows writes and the connection was granted redeploy access.
 */
export async function callRailwayTool(input: {
  allowWrites: boolean;
  args: unknown;
  connection: RailwayToolConnection;
  name: string;
  options?: RailwayCallOptions;
}): Promise<string> {
  const allowed = railwayToolNames(input.connection, input.allowWrites) as string[];
  if (!allowed.includes(input.name)) {
    throw new Error(`The Railway tool ${input.name} is not available to this run`);
  }
  const result = await handlers[input.name as RailwayToolName](
    input.connection,
    input.args ?? {},
    input.options ?? {},
  );
  return JSON.stringify(result).replaceAll(input.connection.accessToken, "[redacted]");
}
