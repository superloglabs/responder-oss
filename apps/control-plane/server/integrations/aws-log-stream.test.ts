import { describe, expect, it, vi } from "vitest";
import {
  type AwsLogStreamDependencies,
  awsRegionSchema,
  prepareAwsLogStream,
  readAwsLogStream,
} from "./aws-log-stream.js";

vi.mock("../../../../packages/core/src/db/organization-capabilities.js", () => ({
  organizationReceivesTelemetry: vi.fn(),
}));
vi.mock("../../../../packages/core/src/db/telemetry-ingest-keys.js", () => ({
  createTelemetryIngestKey: vi.fn(),
}));
vi.mock("../../../../packages/core/src/db/telemetry-sources.js", () => ({
  saveTelemetrySource: vi.fn(),
}));

const organizationId = "10000000-0000-4000-8000-000000000000";
const userId = "user-1";

function dependencies(overrides: Partial<AwsLogStreamDependencies> = {}) {
  return {
    collectorUrl: vi.fn(() => "http://collector:4318"),
    createKey: vi.fn(async () => ({
      key: {
        createdAt: new Date().toISOString(),
        id: "key-1",
        lastUsedAt: null,
        name: "AWS eu-west-1 (superlog-0a1b2c3d)",
        prefix: "sl_ingest_ab",
      },
      token: "sl_ingest_token",
    })),
    createResourcePrefix: vi.fn(() => "superlog-0a1b2c3d"),
    ingestOrigin: vi.fn(() => "https://superlog.sh"),
    receivesTelemetry: vi.fn(async () => true),
    saveSource: vi.fn(async () => ({ id: "source-1", previousIngestKeyId: null, previousState: null })),
    ...overrides,
  } satisfies AwsLogStreamDependencies;
}

describe("AWS log stream", () => {
  it("creates a key and a pending source for the chosen region", async () => {
    const deps = dependencies();
    const prepared = await prepareAwsLogStream(
      { organizationId, previous: null, region: "eu-west-1", userId },
      deps,
    );

    expect(prepared).toEqual({
      parameters: {
        ingestKey: "sl_ingest_token",
        ingestUrl: "https://superlog.sh",
        resourcePrefix: "superlog-0a1b2c3d",
      },
      stream: { ingestKey: "sl_ingest_token", ingestKeyId: "key-1", resourcePrefix: "superlog-0a1b2c3d" },
    });
    expect(deps.createKey).toHaveBeenCalledWith({
      createdBy: userId,
      name: "AWS eu-west-1 (superlog-0a1b2c3d)",
      organizationId,
    });
    expect(deps.saveSource).toHaveBeenCalledWith({
      createdBy: userId,
      displayName: "eu-west-1 · ResponderInvestigationAccess",
      externalId: "superlog-0a1b2c3d",
      ingestKeyId: "key-1",
      organizationId,
      provider: "aws",
      state: { region: "eu-west-1", resourcePrefix: "superlog-0a1b2c3d", stackName: "ResponderInvestigationAccess" },
      status: "pending",
    });
  });

  it("reuses the stored key when the stack is launched again", async () => {
    const deps = dependencies();
    const previous = { ingestKey: "sl_ingest_old", ingestKeyId: "key-0", resourcePrefix: "superlog-99999999" };
    const prepared = await prepareAwsLogStream(
      { organizationId, previous, region: "us-east-1", userId },
      deps,
    );

    expect(prepared?.stream).toEqual(previous);
    expect(prepared?.parameters.ingestKey).toBe("sl_ingest_old");
    expect(deps.createKey).not.toHaveBeenCalled();
    expect(deps.saveSource).toHaveBeenCalledWith(
      expect.objectContaining({
        externalId: "superlog-99999999",
        ingestKeyId: "key-0",
        state: expect.objectContaining({ region: "us-east-1" }),
      }),
    );
  });

  it("streams nothing where the workspace cannot receive telemetry", async () => {
    for (const deps of [
      dependencies({ collectorUrl: vi.fn(() => null) }),
      dependencies({ receivesTelemetry: vi.fn(async () => false) }),
    ]) {
      await expect(
        prepareAwsLogStream({ organizationId, previous: null, region: "eu-west-1", userId }, deps),
      ).resolves.toBeNull();
      expect(deps.createKey).not.toHaveBeenCalled();
      expect(deps.saveSource).not.toHaveBeenCalled();
    }
  });

  it("reads a stored stream only when it is complete", () => {
    const logStream = { ingestKey: "sl_ingest_x", ingestKeyId: "key-1", resourcePrefix: "superlog-0a1b2c3d" };
    expect(readAwsLogStream({ externalId: "x", logStream })).toEqual(logStream);
    expect(readAwsLogStream({ externalId: "x" })).toBeNull();
    expect(readAwsLogStream({ logStream: { ingestKeyId: "key-1" } })).toBeNull();
    expect(readAwsLogStream(null)).toBeNull();
  });

  it("accepts only commercial regions", () => {
    expect(awsRegionSchema.safeParse("eu-west-1").success).toBe(true);
    expect(awsRegionSchema.safeParse("us-gov-west-1").success).toBe(false);
    expect(awsRegionSchema.safeParse("cn-north-1").success).toBe(false);
  });
});
