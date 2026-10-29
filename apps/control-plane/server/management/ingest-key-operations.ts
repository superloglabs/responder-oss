import { z } from "zod";
import { organizationHasCapability } from "../../../../packages/core/src/db/organization-capabilities.js";
import {
  createTelemetryIngestKey,
  listTelemetryIngestKeys,
} from "../../../../packages/core/src/db/telemetry-ingest-keys.js";
import { telemetryCollectorUrl } from "../../../../packages/core/src/telemetry/client.js";
import { cellOrigin } from "../integrations/urls.js";
import { defineOperation, ManagementError, type ManagementContext } from "./operation.js";

// Keys applications send telemetry with. A key can only add telemetry to its
// workspace, so an agent may create one and put it in an app's environment.

const keySchema = z.object({
  createdAt: z.string(),
  id: z.string(),
  lastUsedAt: z.string().nullable().describe("When the key last sent telemetry. Null until it is used."),
  name: z.string(),
  prefix: z.string().describe("The start of the key, to tell keys apart."),
});

async function requireIngest(context: ManagementContext): Promise<void> {
  if (!telemetryCollectorUrl() || !(await organizationHasCapability(context.organizationId, "telemetry"))) {
    throw new ManagementError(404, "Sending telemetry is not available in this workspace.", "telemetry_unavailable");
  }
}

// Ingest is not routed between cells, so keys send to this cell's own origin.
function ingestEndpoint(): string {
  return `${cellOrigin()}/api/ingest`;
}

export const ingestKeyOperations = [
  defineOperation({
    name: "list_ingest_keys",
    summary: "List ingest keys",
    description: "Lists the workspace's ingest keys, newest first, with when each one last sent telemetry. Key values are not returned.",
    method: "GET",
    path: "/ingest-keys",
    tag: "Telemetry",
    effect: "read",
    input: z.object({}),
    output: z.object({ endpoint: z.string().describe("The OTLP/HTTP endpoint the keys send to."), keys: z.array(keySchema) }),
    async run(context) {
      await requireIngest(context);
      return { endpoint: ingestEndpoint(), keys: await listTelemetryIngestKeys(context.organizationId) };
    },
  }),
  defineOperation({
    name: "create_ingest_key",
    summary: "Create an ingest key",
    description:
      "Creates a key that applications send logs, traces, and metrics with, and returns its value once. The key can only add telemetry to this workspace. Put it in the app's environment or secret manager, never in a committed file. Browser apps may embed it.",
    method: "POST",
    path: "/ingest-keys",
    tag: "Telemetry",
    effect: "write",
    successStatus: 201,
    input: z.object({
      name: z.string().trim().min(1).max(120).describe("What the key is for, such as the service or environment."),
    }),
    output: z.object({
      endpoint: z.string().describe("The OTLP/HTTP endpoint. SDKs add /v1/logs, /v1/traces, and /v1/metrics."),
      environment: z.record(z.string(), z.string()).describe("OpenTelemetry SDK settings for the key."),
      key: keySchema,
      token: z.string().describe("The key. It is not shown again."),
    }),
    async run(context, input) {
      await requireIngest(context);
      const created = await createTelemetryIngestKey({
        createdBy: context.user.id,
        name: input.name,
        organizationId: context.organizationId,
      });
      const endpoint = ingestEndpoint();
      return {
        endpoint,
        environment: {
          OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
          OTEL_EXPORTER_OTLP_HEADERS: `x-api-key=${created.token}`,
          OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
        },
        key: created.key,
        token: created.token,
      };
    },
  }),
];
