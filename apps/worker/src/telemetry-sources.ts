import { decryptCredentials } from "@responder/core/credentials/encryption";
import { listGcpTelemetrySources, updateTelemetrySource } from "@responder/core/db/telemetry-sources";
import {
  createGcpAuthClient,
  gcpConnectionCredentialsSchema,
  type GcpConnectionCredentials,
} from "@responder/core/integrations/gcp";
import { telemetryCollectorUrl } from "@responder/core/telemetry/client";
import { forwardToCollector } from "@responder/core/telemetry/forward";
import { type GcpRequest, pullGcpSource } from "@responder/core/telemetry/sources/gcp-pull";

// Reads every Google Cloud telemetry source once. Sources are read a few at a
// time; each one's Google client is kept so its token is reused across passes.

const concurrentSources = 4;

export interface GcpTelemetryPullDependencies {
  collectorUrl: () => string | null;
  createRequest: (credentials: GcpConnectionCredentials) => GcpRequest;
  decrypt: (encrypted: string) => Record<string, unknown>;
  forward: typeof forwardToCollector;
  list: typeof listGcpTelemetrySources;
  now: () => Date;
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

export const defaultGcpTelemetryPullDependencies: GcpTelemetryPullDependencies = {
  collectorUrl: telemetryCollectorUrl,
  createRequest: cachedRequest,
  decrypt: (encrypted) => decryptCredentials(encrypted),
  forward: forwardToCollector,
  list: listGcpTelemetrySources,
  now: () => new Date(),
  update: updateTelemetrySource,
};

export async function pullGcpTelemetrySources(
  dependencies: GcpTelemetryPullDependencies = defaultGcpTelemetryPullDependencies,
): Promise<{ failed: number; sources: number }> {
  const collector = dependencies.collectorUrl();
  if (!collector) return { failed: 0, sources: 0 };
  const collectorUrl: string = collector;
  const sources = await dependencies.list();
  let failed = 0;
  const queue = [...sources];
  async function next(): Promise<void> {
    for (let source = queue.shift(); source; source = queue.shift()) {
      try {
        const credentials = gcpConnectionCredentialsSchema.parse(dependencies.decrypt(source.encryptedCredentials));
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
          gcpProjectId: credentials.projectId,
          now,
          request: dependencies.createRequest(credentials),
          state: source.state,
        });
        if (result.error) failed += 1;
        await dependencies.update(source.id, {
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
            sourceId: source.id,
          }));
        }
      } catch (error) {
        failed += 1;
        await dependencies
          .update(source.id, { lastError: error instanceof Error ? error.message : String(error), status: "failed" })
          .catch(() => undefined);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrentSources, sources.length) }, next));
  return { failed, sources: sources.length };
}
