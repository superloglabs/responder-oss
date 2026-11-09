import { describe, expect, it, vi } from "vitest";
import {
  type AwsLogStreamDependencies,
  awsRegionSchema,
  commitAwsLogStream,
  prepareAwsLogStream,
  readAwsLogStream,
} from "./aws-log-stream.js";

vi.mock("../../../../packages/core/src/db/organization-capabilities.js", () => ({
  organizationReceivesTelemetry: vi.fn(),
}));
vi.mock("../../../../packages/core/src/db/telemetry-ingest-keys.js", () => ({
  createTelemetryIngestKey: vi.fn(),
  findTelemetryIngestKey: vi.fn(),
  revokeTelemetryIngestKey: vi.fn(),
}));
vi.mock("../../../../packages/core/src/db/telemetry-sources.js", () => ({
  saveTelemetrySource: vi.fn(),
}));

const organizationId = "10000000-0000-4000-8000-000000000000";
const userId = "user-1";
const previous = { ingestKey: "sl_ingest_old", ingestKeyId: "key-0", resourcePrefix: "superlog-99999999" };

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
    keyIsActive: vi.fn(async () => true),
    receivesTelemetry: vi.fn(async () => true),
    revokeKey: vi.fn(async () => undefined),
    saveSource: vi.fn(async () => ({ id: "source-1", previousIngestKeyId: null, previousState: null })),
    ...overrides,
  } satisfies AwsLogStreamDependencies;
}

describe("AWS log stream", () => {
  it("creates a key for the chosen region without saving anything", async () => {
    const deps = dependencies();
    const prepared = await prepareAwsLogStream(
      { organizationId, previous: null, region: "eu-west-1", userId },
      deps,
    );

    expect(prepared).toEqual({
      created: true,
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
    expect(deps.saveSource).not.toHaveBeenCalled();
  });

  it("reuses a stored key that is still active", async () => {
    const deps = dependencies();
    const prepared = await prepareAwsLogStream(
      { organizationId, previous, region: "us-east-1", userId },
      deps,
    );

    expect(prepared).toMatchObject({ created: false, stream: previous });
    expect(prepared?.parameters.ingestKey).toBe("sl_ingest_old");
    expect(deps.keyIsActive).toHaveBeenCalledWith({ keyId: "key-0", organizationId, token: "sl_ingest_old" });
    expect(deps.createKey).not.toHaveBeenCalled();
  });

  it("replaces a stored key that was revoked", async () => {
    const deps = dependencies({ keyIsActive: vi.fn(async () => false) });
    const prepared = await prepareAwsLogStream(
      { organizationId, previous, region: "us-east-1", userId },
      deps,
    );

    expect(prepared).toMatchObject({
      created: true,
      stream: { ingestKey: "sl_ingest_token", ingestKeyId: "key-1", resourcePrefix: "superlog-0a1b2c3d" },
    });
    expect(deps.createKey).toHaveBeenCalledTimes(1);
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
    }
  });

  it("saves the connection, then a pending source for the region", async () => {
    const order: string[] = [];
    const deps = dependencies({
      saveSource: vi.fn(async () => {
        order.push("source");
        return { id: "source-1", previousIngestKeyId: null, previousState: null };
      }),
    });
    const prepared = await prepareAwsLogStream({ organizationId, previous: null, region: "eu-west-1", userId }, deps);

    const saved = await commitAwsLogStream(
      {
        organizationId,
        prepared,
        region: "eu-west-1",
        saveConnection: async () => {
          order.push("connection");
          return "account-1";
        },
        userId,
      },
      deps,
    );

    expect(saved).toBe("account-1");
    expect(order).toEqual(["connection", "source"]);
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
    expect(deps.revokeKey).not.toHaveBeenCalled();
  });

  it("revokes a new key when the connection cannot be saved", async () => {
    const deps = dependencies();
    const prepared = await prepareAwsLogStream({ organizationId, previous: null, region: "eu-west-1", userId }, deps);

    await expect(
      commitAwsLogStream(
        {
          organizationId,
          prepared,
          region: "eu-west-1",
          saveConnection: async () => {
            throw new Error("database unavailable");
          },
          userId,
        },
        deps,
      ),
    ).rejects.toThrow("database unavailable");
    expect(deps.revokeKey).toHaveBeenCalledWith({ keyId: "key-1", organizationId, userId });
    expect(deps.saveSource).not.toHaveBeenCalled();
  });

  it("keeps a reused key when the connection cannot be saved", async () => {
    const deps = dependencies();
    const prepared = await prepareAwsLogStream({ organizationId, previous, region: "eu-west-1", userId }, deps);

    await expect(
      commitAwsLogStream(
        {
          organizationId,
          prepared,
          region: "eu-west-1",
          saveConnection: async () => {
            throw new Error("database unavailable");
          },
          userId,
        },
        deps,
      ),
    ).rejects.toThrow("database unavailable");
    expect(deps.revokeKey).not.toHaveBeenCalled();
  });

  it("logs a key it could not revoke and still reports the save error", async () => {
    const deps = dependencies({ revokeKey: vi.fn(async () => { throw new Error("revoke failed"); }) });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const prepared = await prepareAwsLogStream({ organizationId, previous: null, region: "eu-west-1", userId }, deps);

    await expect(
      commitAwsLogStream(
        {
          organizationId,
          prepared,
          region: "eu-west-1",
          saveConnection: async () => {
            throw new Error("database unavailable");
          },
          userId,
        },
        deps,
      ),
    ).rejects.toThrow("database unavailable");
    expect(JSON.parse(String(logged.mock.calls[0]?.[0]))).toEqual({
      error: "revoke failed",
      event: "aws_log_stream_key_revoke_failed",
      keyId: "key-1",
      organizationId,
    });
    logged.mockRestore();
  });

  it("keeps the key with the saved connection when the source cannot be saved", async () => {
    const deps = dependencies({ saveSource: vi.fn(async () => { throw new Error("source failed"); }) });
    const prepared = await prepareAwsLogStream({ organizationId, previous: null, region: "eu-west-1", userId }, deps);
    const saveConnection = vi.fn(async () => "account-1");

    await expect(
      commitAwsLogStream({ organizationId, prepared, region: "eu-west-1", saveConnection, userId }, deps),
    ).rejects.toThrow("source failed");
    expect(saveConnection).toHaveBeenCalledTimes(1);
    expect(deps.revokeKey).not.toHaveBeenCalled();
  });

  it("saves only the connection without a stream", async () => {
    const deps = dependencies();
    await expect(
      commitAwsLogStream(
        { organizationId, prepared: null, region: undefined, saveConnection: async () => "account-1", userId },
        deps,
      ),
    ).resolves.toBe("account-1");
    expect(deps.saveSource).not.toHaveBeenCalled();
  });

  it("reads a stored stream only when it is complete", () => {
    const logStream = { ingestKey: "sl_ingest_x", ingestKeyId: "key-1", resourcePrefix: "superlog-0a1b2c3d" };
    expect(readAwsLogStream({ externalId: "x", logStream })).toEqual(logStream);
    expect(readAwsLogStream({ externalId: "x" })).toBeNull();
    expect(readAwsLogStream({ logStream: { ingestKeyId: "key-1" } })).toBeNull();
    expect(readAwsLogStream(null)).toBeNull();
  });

  it("accepts only regions AWS has", () => {
    expect(awsRegionSchema.safeParse("eu-west-1").success).toBe(true);
    expect(awsRegionSchema.safeParse("us-foobar-1").success).toBe(false);
    expect(awsRegionSchema.safeParse("us-gov-west-1").success).toBe(false);
    expect(awsRegionSchema.safeParse("cn-north-1").success).toBe(false);
  });
});
