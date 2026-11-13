import { decryptCredentials } from "@responder/core/credentials/encryption";
import { railwayAccessToken } from "@responder/core/db/railway-access";
import {
  listGcpSharedReaderSources,
  listGcpTelemetrySources,
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
  const collector = dependencies.collectorUrl();
  if (!collector) return { failed: 0, sources: 0 };
  const collectorUrl: string = collector;
  const queue = await dependencies.list();
  const total = queue.length;
  let failed = 0;
  async function next(): Promise<void> {
    for (let source = queue.shift(); source; source = queue.shift()) {
      try {
        const accessToken = await dependencies.accessToken({
          integrationAccountId: source.integrationAccountId,
          organizationId: source.organizationId,
        });
        // The connection was removed or lost access since it was listed.
        if (!accessToken) continue;
        const organizationId = source.organizationId;
        const now = dependencies.now();
        const result = await dependencies.pull({
          accessToken,
          environmentId: source.environmentId,
          forward: async (payload) => {
            const response = await dependencies.forward({
              body: JSON.stringify(payload),
              collectorUrl,
              contentType: "application/json",
              organizationId,
              signal: "logs",
            });
            return response.ok;
          },
          now,
          state: source.state,
        });
        if (result.error) failed += 1;
        await dependencies.update(source.id, {
          lastError: result.error,
          state: result.state,
          status: result.error && !result.received ? "failed" : "active",
          ...(result.received ? { lastReceivedAt: now } : {}),
        });
        if (result.received || result.error || result.truncated) {
          console.log(JSON.stringify({
            error: result.error,
            event: "railway_telemetry_pulled",
            logs: result.logs,
            organizationId,
            sourceId: source.id,
            truncated: result.truncated,
          }));
        }
      } catch (error) {
        failed += 1;
        const message = error instanceof McpOAuthRefreshError && error.reconnectRequired
          ? "Railway refused the connection's access. Reconnect Railway."
          : error instanceof Error ? error.message : String(error);
        await dependencies
          .update(source.id, { lastError: message, status: "failed" })
          .catch(() => undefined);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrentSources, total) }, next));
  return { failed, sources: total };
}
