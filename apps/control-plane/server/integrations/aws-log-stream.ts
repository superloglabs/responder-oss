import { z } from "zod";
import { organizationReceivesTelemetry } from "../../../../packages/core/src/db/organization-capabilities.js";
import { createTelemetryIngestKey } from "../../../../packages/core/src/db/telemetry-ingest-keys.js";
import { saveTelemetrySource } from "../../../../packages/core/src/db/telemetry-sources.js";
import {
  AWS_INVESTIGATION_STACK_NAME,
  type AwsLogStreamParameters,
  isAwsCommercialRegion,
} from "../../../../packages/core/src/integrations/aws.js";
import { telemetryCollectorUrl } from "../../../../packages/core/src/telemetry/client.js";
import { createAwsTelemetryResourcePrefix } from "../../../../packages/core/src/telemetry/sources/aws-telemetry.js";
import { cellOrigin } from "./urls.js";

// The AWS connection stack also streams the region it runs in to the
// workspace's telemetry, so error logs open error issues. The ingest key's
// token is shown only once, so it is kept, encrypted, with the pending
// connection: launching the stack again reuses the same key and resources.

export const awsRegionSchema = z.string().refine(isAwsCommercialRegion);

export const awsLogStreamSchema = z.object({
  ingestKeyId: z.string().min(1),
  ingestKey: z.string().min(1),
  resourcePrefix: z.string().min(1),
});

export type AwsLogStream = z.infer<typeof awsLogStreamSchema>;

export type AwsLogStreamDependencies = {
  collectorUrl: () => string | null;
  createKey: typeof createTelemetryIngestKey;
  createResourcePrefix: () => string;
  ingestOrigin: () => string;
  receivesTelemetry: (organizationId: string) => Promise<boolean>;
  saveSource: typeof saveTelemetrySource;
};

const defaultDependencies: AwsLogStreamDependencies = {
  collectorUrl: () => telemetryCollectorUrl(),
  createKey: createTelemetryIngestKey,
  createResourcePrefix: createAwsTelemetryResourcePrefix,
  ingestOrigin: cellOrigin,
  receivesTelemetry: organizationReceivesTelemetry,
  saveSource: saveTelemetrySource,
};

export function readAwsLogStream(credentials: unknown): AwsLogStream | null {
  const parsed = z.object({ logStream: awsLogStreamSchema }).safeParse(credentials);
  return parsed.success ? parsed.data.logStream : null;
}

// Null when the workspace cannot receive telemetry here; the stack then
// creates only the role.
export async function prepareAwsLogStream(
  input: {
    organizationId: string;
    previous: AwsLogStream | null;
    region: string;
    userId: string;
  },
  dependencies: AwsLogStreamDependencies = defaultDependencies,
): Promise<{ parameters: AwsLogStreamParameters; stream: AwsLogStream } | null> {
  if (!dependencies.collectorUrl()) return null;
  if (!(await dependencies.receivesTelemetry(input.organizationId))) return null;
  let stream = input.previous;
  if (!stream) {
    const resourcePrefix = dependencies.createResourcePrefix();
    const created = await dependencies.createKey({
      createdBy: input.userId,
      name: `AWS ${input.region} (${resourcePrefix})`,
      organizationId: input.organizationId,
    });
    stream = { ingestKey: created.token, ingestKeyId: created.key.id, resourcePrefix };
  }
  // Keyed by the resource prefix, so a relaunch in another region moves the
  // source instead of adding one.
  await dependencies.saveSource({
    createdBy: input.userId,
    displayName: `${input.region} · ${AWS_INVESTIGATION_STACK_NAME}`,
    externalId: stream.resourcePrefix,
    ingestKeyId: stream.ingestKeyId,
    organizationId: input.organizationId,
    provider: "aws",
    state: {
      region: input.region,
      resourcePrefix: stream.resourcePrefix,
      stackName: AWS_INVESTIGATION_STACK_NAME,
    },
    status: "pending",
  });
  return {
    parameters: {
      ingestKey: stream.ingestKey,
      ingestUrl: dependencies.ingestOrigin(),
      resourcePrefix: stream.resourcePrefix,
    },
    stream,
  };
}
