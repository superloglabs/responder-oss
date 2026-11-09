import { z } from "zod";
import { organizationReceivesTelemetry } from "../../../../packages/core/src/db/organization-capabilities.js";
import {
  createTelemetryIngestKey,
  findTelemetryIngestKey,
  revokeTelemetryIngestKey,
} from "../../../../packages/core/src/db/telemetry-ingest-keys.js";
import { saveTelemetrySource } from "../../../../packages/core/src/db/telemetry-sources.js";
import {
  AWS_INVESTIGATION_STACK_NAME,
  type AwsLogStreamParameters,
} from "../../../../packages/core/src/integrations/aws.js";
import { isOfferedAwsRegion } from "../../../../packages/core/src/integrations/aws-regions.js";
import { telemetryCollectorUrl } from "../../../../packages/core/src/telemetry/client.js";
import { createAwsTelemetryResourcePrefix } from "../../../../packages/core/src/telemetry/sources/aws-telemetry.js";
import { cellOrigin } from "./urls.js";

// The AWS connection stack also streams the region it runs in to the
// workspace's telemetry, so error logs open error issues. The ingest key's
// token is shown only once, so it is kept, encrypted, with the pending
// connection: launching the stack again reuses the same key and resources.

export const awsRegionSchema = z.string().refine(isOfferedAwsRegion);

export const awsLogStreamSchema = z.object({
  ingestKeyId: z.string().min(1),
  ingestKey: z.string().min(1),
  resourcePrefix: z.string().min(1),
});

export type AwsLogStream = z.infer<typeof awsLogStreamSchema>;

export type PreparedAwsLogStream = {
  // True when this request made the key, so it must be saved or revoked.
  created: boolean;
  parameters: AwsLogStreamParameters;
  stream: AwsLogStream;
};

export type AwsLogStreamDependencies = {
  collectorUrl: () => string | null;
  createKey: typeof createTelemetryIngestKey;
  createResourcePrefix: () => string;
  ingestOrigin: () => string;
  keyIsActive: (input: { keyId: string; organizationId: string; token: string }) => Promise<boolean>;
  receivesTelemetry: (organizationId: string) => Promise<boolean>;
  revokeKey: (input: { keyId: string; organizationId: string; userId: string }) => Promise<void>;
  saveSource: typeof saveTelemetrySource;
};

const defaultDependencies: AwsLogStreamDependencies = {
  collectorUrl: () => telemetryCollectorUrl(),
  createKey: createTelemetryIngestKey,
  createResourcePrefix: createAwsTelemetryResourcePrefix,
  ingestOrigin: cellOrigin,
  keyIsActive: async ({ keyId, organizationId, token }) => {
    const key = await findTelemetryIngestKey(token);
    return key?.keyId === keyId && key.organizationId === organizationId;
  },
  receivesTelemetry: organizationReceivesTelemetry,
  // The requester made the key, so the creator rule lets them revoke it.
  revokeKey: async ({ keyId, organizationId, userId }) => {
    await revokeTelemetryIngestKey({ keyId, organizationId, role: "member", userId });
  },
  saveSource: saveTelemetrySource,
};

export function readAwsLogStream(credentials: unknown): AwsLogStream | null {
  const parsed = z.object({ logStream: awsLogStreamSchema }).safeParse(credentials);
  return parsed.success ? parsed.data.logStream : null;
}

// The key and parameters for the stack. A stored key is reused while it is
// active; one revoked since, such as by removing its source, is replaced.
// Null when the workspace cannot receive telemetry here; the stack then
// creates only the role. Saves nothing: commitAwsLogStream does that.
export async function prepareAwsLogStream(
  input: {
    organizationId: string;
    previous: AwsLogStream | null;
    region: string;
    userId: string;
  },
  dependencies: AwsLogStreamDependencies = defaultDependencies,
): Promise<PreparedAwsLogStream | null> {
  if (!dependencies.collectorUrl()) return null;
  if (!(await dependencies.receivesTelemetry(input.organizationId))) return null;
  const previous = input.previous;
  const reusable = previous
    ? await dependencies.keyIsActive({
        keyId: previous.ingestKeyId,
        organizationId: input.organizationId,
        token: previous.ingestKey,
      })
    : false;
  let stream: AwsLogStream;
  if (previous && reusable) {
    stream = previous;
  } else {
    const resourcePrefix = dependencies.createResourcePrefix();
    const created = await dependencies.createKey({
      createdBy: input.userId,
      name: `AWS ${input.region} (${resourcePrefix})`,
      organizationId: input.organizationId,
    });
    stream = { ingestKey: created.token, ingestKeyId: created.key.id, resourcePrefix };
  }
  return {
    created: stream !== previous,
    parameters: {
      ingestKey: stream.ingestKey,
      ingestUrl: dependencies.ingestOrigin(),
      resourcePrefix: stream.resourcePrefix,
    },
    stream,
  };
}

// Saves the connection that keeps the key, then the stream's source. If the
// connection cannot be saved, a key made for this request is revoked, so no
// key is left active that nothing records. A failed source save leaves the
// key with the connection, and the next launch saves the source again.
export async function commitAwsLogStream<T>(
  input: {
    organizationId: string;
    prepared: PreparedAwsLogStream | null;
    region: string | undefined;
    saveConnection: () => Promise<T>;
    userId: string;
  },
  dependencies: AwsLogStreamDependencies = defaultDependencies,
): Promise<T> {
  const { prepared } = input;
  let saved: T;
  try {
    saved = await input.saveConnection();
  } catch (error) {
    if (prepared?.created) {
      await dependencies
        .revokeKey({ keyId: prepared.stream.ingestKeyId, organizationId: input.organizationId, userId: input.userId })
        .catch(() => undefined);
    }
    throw error;
  }
  if (prepared && input.region) {
    // Keyed by the resource prefix, so a relaunch in another region moves the
    // source instead of adding one.
    await dependencies.saveSource({
      createdBy: input.userId,
      displayName: `${input.region} · ${AWS_INVESTIGATION_STACK_NAME}`,
      externalId: prepared.stream.resourcePrefix,
      ingestKeyId: prepared.stream.ingestKeyId,
      organizationId: input.organizationId,
      provider: "aws",
      state: {
        region: input.region,
        resourcePrefix: prepared.stream.resourcePrefix,
        stackName: AWS_INVESTIGATION_STACK_NAME,
      },
      status: "pending",
    });
  }
  return saved;
}
