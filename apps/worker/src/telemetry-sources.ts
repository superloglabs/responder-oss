import { decryptCredentials } from "@responder/core/credentials/encryption";
import { postHogAccessToken } from "@responder/core/db/posthog-access";
import { railwayAccessToken } from "@responder/core/db/railway-access";
import {
  listGcpSharedReaderSources,
  listGcpTelemetrySources,
  listPostHogTelemetrySources,
  listRailwayTelemetrySources,
  updateTelemetrySource,
} from "@responder/core/db/telemetry-sources";
import {
  createGcpAuthClient,
  createGcpSharedReaderClient,
  gcpConnectionCredentialsSchema,
  type GcpConnectionCredentials,
  gcpSharedReaderConfig,
  type GcpSharedReaderConfig,
} from "@responder/core/integrations/gcp";
import { McpOAuthRefreshError } from "@responder/core/integrations/custom-mcp";
import { telemetryCollectorUrl } from "@responder/core/telemetry/client";
import { forwardToCollector } from "@responder/core/telemetry/forward";
import { type GcpRequest, pullGcpSource } from "@responder/core/telemetry/sources/gcp-pull";
import { pullPostHogSource } from "@responder/core/telemetry/sources/posthog-pull";
import { pullRailwaySource } from "@responder/core/telemetry/sources/railway-pull";

// Reads every Google Cloud telemetry source once. Sources are read a few at a
// time; each one's Google client is kept so its token is reused across passes.
// Sources without an integration account are read with the operator's shared
// reader, which may read Cloud Monitoring only, so they get metrics and no logs.

const concurrentSources = 4;

export interface GcpTelemetryPullDependencies {
  collectorUrl: () => string | null;
  createRequest: (credentials: GcpConnectionCredentials) => GcpRequest;
  createSharedRequest: (reader: GcpSharedReaderConfig) => GcpRequest;
  decrypt: (encrypted: string) => Record<string, unknown>;
  forward: typeof forwardToCollector;
  list: typeof listGcpTelemetrySources;
  listShared: typeof listGcpSharedReaderSources;
  now: () => Date;
  sharedReader: () => GcpSharedReaderConfig | null;
  update: typeof updateTelemetrySource;
}

const clients = new Map<string, { request: GcpRequest; sessionName: string }>();

function cachedRequest(credentials: GcpConnectionCredentials): GcpRequest {
  const cached = clients.get(credentials.projectId);
  if (cached?.sessionName === credentials.sessionName) return cached.request;
  const client = createGcpAuthClient(credentials);
  const request: GcpRequest = async (input) =>
    (await client.request({ data: input.data, method: input.method, timeout: 30_000, url: input.url })).data;
  clients.set(credentials.projectId, { request, sessionName: credentials.sessionName });
  return request;
}

let sharedClient: { key: string; request: GcpRequest } | null = null;

function cachedSharedRequest(reader: GcpSharedReaderConfig): GcpRequest {
  const key = `${reader.audience} ${reader.serviceAccount}`;
  if (sharedClient?.key === key) return sharedClient.request;
  const client = createGcpSharedReaderClient(reader);
  const request: GcpRequest = async (input) =>
    (await client.request({ data: input.data, method: input.method, timeout: 30_000, url: input.url })).data;
  sharedClient = { key, request };
  return request;
}

export const defaultGcpTelemetryPullDependencies: GcpTelemetryPullDependencies = {
  collectorUrl: telemetryCollectorUrl,
  createRequest: cachedRequest,
  createSharedRequest: cachedSharedRequest,
  decrypt: (encrypted) => decryptCredentials(encrypted),
  forward: forwardToCollector,
  list: listGcpTelemetrySources,
  listShared: listGcpSharedReaderSources,
  now: () => new Date(),
  sharedReader: () => gcpSharedReaderConfig(),
  update: updateTelemetrySource,
};

type PullTarget = {
  gcpProjectId: string;
  logs: boolean;
  organizationId: string;
  request: GcpRequest;
  state: Record<string, unknown>;
};

export async function pullGcpTelemetrySources(
  dependencies: GcpTelemetryPullDependencies = defaultGcpTelemetryPullDependencies,
): Promise<{ failed: number; sources: number }> {
  const collector = dependencies.collectorUrl();
  if (!collector) return { failed: 0, sources: 0 };
  const collectorUrl: string = collector;
  const connected = await dependencies.list();
  const reader = dependencies.sharedReader();
  const shared = reader ? await dependencies.listShared() : [];
  let failed = 0;
  // Each entry resolves its client when it is read, so a source whose
  // credentials cannot be read fails alone.
  const queue: Array<{ id: string; target: () => PullTarget }> = [
    ...connected.map((source) => ({
      id: source.id,
      target: (): PullTarget => {
        const credentials = gcpConnectionCredentialsSchema.parse(dependencies.decrypt(source.encryptedCredentials));
        return {
          gcpProjectId: credentials.projectId,
          logs: true,
          organizationId: source.organizationId,
          request: dependencies.createRequest(credentials),
          state: source.state,
        };
      },
    })),
    ...shared.map((source) => ({
      id: source.id,
      target: (): PullTarget => ({
        gcpProjectId: source.gcpProjectId,
        logs: false,
        organizationId: source.organizationId,
        request: dependencies.createSharedRequest(reader!),
        state: source.state,
      }),
    })),
  ];
  const total = queue.length;
  async function next(): Promise<void> {
    for (let entry = queue.shift(); entry; entry = queue.shift()) {
      try {
        const source = entry.target();
        const organizationId = source.organizationId;
        const now = dependencies.now();
        const result = await pullGcpSource({
          forward: async (signal, payload) => {
            const response = await dependencies.forward({
              body: JSON.stringify(payload),
              collectorUrl,
              contentType: "application/json",
              organizationId,
              signal,
            });
            return response.ok;
          },
          gcpProjectId: source.gcpProjectId,
          logs: source.logs,
          now,
          request: source.request,
          state: source.state,
        });
        if (result.error) failed += 1;
        await dependencies.update(entry.id, {
          lastError: result.error,
          state: result.state,
          status: result.error && !result.received ? "failed" : "active",
          ...(result.received ? { lastReceivedAt: now } : {}),
        });
        if (result.received || result.error) {
          console.log(JSON.stringify({
            error: result.error,
            event: "gcp_telemetry_pulled",
            logs: result.logs,
            organizationId: source.organizationId,
            points: result.points,
            sourceId: entry.id,
          }));
        }
      } catch (error) {
        failed += 1;
        await dependencies
          .update(entry.id, { lastError: error instanceof Error ? error.message : String(error), status: "failed" })
          .catch(() => undefined);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrentSources, total) }, next));
  return { failed, sources: total };
}

// Reads every Railway telemetry source once, a few at a time. Each read gets
// the connection's access token, refreshed when it is about to expire.

export interface RailwayTelemetryPullDependencies {
  accessToken: typeof railwayAccessToken;
  collectorUrl: () => string | null;
  forward: typeof forwardToCollector;
  list: typeof listRailwayTelemetrySources;
  now: () => Date;
  pull: typeof pullRailwaySource;
  update: typeof updateTelemetrySource;
}

export const defaultRailwayTelemetryPullDependencies: RailwayTelemetryPullDependencies = {
  accessToken: railwayAccessToken,
  collectorUrl: telemetryCollectorUrl,
  forward: forwardToCollector,
  list: listRailwayTelemetrySources,
  now: () => new Date(),
  pull: pullRailwaySource,
  update: updateTelemetrySource,
};

export async function pullRailwayTelemetrySources(
  dependencies: RailwayTelemetryPullDependencies = defaultRailwayTelemetryPullDependencies,
): Promise<{ failed: number; sources: number }> {
  return pullOAuthLogSources({
    ...dependencies,
    event: "railway_telemetry_pulled",
    pull: (source, accessToken, forward, now) => dependencies.pull({
      accessToken,
      environmentId: source.environmentId,
      forward,
      now,
      state: source.state,
    }),
    refused: "Railway refused the connection's access. Reconnect Railway.",
  });
}

export interface PostHogTelemetryPullDependencies {
  accessToken: typeof postHogAccessToken;
  collectorUrl: () => string | null;
  forward: typeof forwardToCollector;
  list: typeof listPostHogTelemetrySources;
  now: () => Date;
  pull: typeof pullPostHogSource;
  update: typeof updateTelemetrySource;
}

export const defaultPostHogTelemetryPullDependencies: PostHogTelemetryPullDependencies = {
  accessToken: postHogAccessToken,
  collectorUrl: telemetryCollectorUrl,
  forward: forwardToCollector,
  list: listPostHogTelemetrySources,
  now: () => new Date(),
  pull: pullPostHogSource,
  update: updateTelemetrySource,
};

// Reads the error lines of every PostHog project a workspace chose, once.
export async function pullPostHogTelemetrySources(
  dependencies: PostHogTelemetryPullDependencies = defaultPostHogTelemetryPullDependencies,
): Promise<{ failed: number; sources: number }> {
  return pullOAuthLogSources({
    ...dependencies,
    event: "posthog_telemetry_pulled",
    pull: (source, accessToken, forward, now) => dependencies.pull({
      accessToken,
      forward,
      now,
      projectId: source.projectId,
      state: source.state,
    }),
    refused: "PostHog refused the connection's access. Reconnect PostHog.",
  });
}

// Reads every log source of one OAuth provider once, a few at a time, with
// each source's connection token, and records how each read went.
async function pullOAuthLogSources<Source extends { id: string; integrationAccountId: string; organizationId: string }>(config: {
  accessToken: (input: { integrationAccountId: string; organizationId: string }) => Promise<string | null>;
  collectorUrl: () => string | null;
  event: string;
  forward: typeof forwardToCollector;
  list: () => Promise<Source[]>;
  now: () => Date;
  pull: (
    source: Source,
    accessToken: string,
    forward: (payload: unknown) => Promise<boolean>,
    now: Date,
  ) => Promise<{ error: string | null; logs: number; received: boolean; state: Record<string, unknown>; truncated: boolean }>;
  refused: string;
  update: typeof updateTelemetrySource;
}): Promise<{ failed: number; sources: number }> {
  const collector = config.collectorUrl();
  if (!collector) return { failed: 0, sources: 0 };
  const collectorUrl: string = collector;
  const queue = await config.list();
  const total = queue.length;
  let failed = 0;
  async function next(): Promise<void> {
    for (let source = queue.shift(); source; source = queue.shift()) {
      try {
        const accessToken = await config.accessToken({
          integrationAccountId: source.integrationAccountId,
          organizationId: source.organizationId,
        });
        // The connection was removed or lost access since it was listed.
        if (!accessToken) continue;
        const organizationId = source.organizationId;
        const now = config.now();
        const result = await config.pull(source, accessToken, async (payload) => {
          const response = await config.forward({
            body: JSON.stringify(payload),
            collectorUrl,
            contentType: "application/json",
            organizationId,
            signal: "logs",
          });
          return response.ok;
        }, now);
        if (result.error) failed += 1;
        await config.update(source.id, {
          lastError: result.error,
          state: result.state,
          status: result.error && !result.received ? "failed" : "active",
          ...(result.received ? { lastReceivedAt: now } : {}),
        });
        if (result.received || result.error || result.truncated) {
          console.log(JSON.stringify({
            error: result.error,
            event: config.event,
            logs: result.logs,
            organizationId,
            sourceId: source.id,
            truncated: result.truncated,
          }));
        }
      } catch (error) {
        failed += 1;
        const message = error instanceof McpOAuthRefreshError && error.reconnectRequired
          ? config.refused
          : error instanceof Error ? error.message : String(error);
        await config
          .update(source.id, { lastError: message, status: "failed" })
          .catch(() => undefined);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrentSources, total) }, next));
  return { failed, sources: total };
}
