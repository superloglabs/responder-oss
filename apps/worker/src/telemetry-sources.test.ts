import { describe, expect, it, vi } from "vitest";
import { McpOAuthRefreshError } from "@responder/core/integrations/custom-mcp";
import {
  type GcpTelemetryPullDependencies,
  pullGcpTelemetrySources,
  pullRailwayTelemetrySources,
  type RailwayTelemetryPullDependencies,
} from "./telemetry-sources.js";

const credentials = { projectId: "shop-prod", projectNumber: "123456789", sessionName: `responder-gcp-${"a".repeat(32)}` };

function dependencies(overrides: Partial<GcpTelemetryPullDependencies> = {}): GcpTelemetryPullDependencies {
  return {
    collectorUrl: () => "http://collector:4318",
    createRequest: () => async (input) =>
      input.url.includes("entries:list")
        ? { entries: [{ resource: { type: "global" }, textPayload: "hi", timestamp: "2026-10-15T09:58:00Z" }] }
        : { timeSeries: [] },
    createSharedRequest: () => async () => ({ timeSeries: [] }),
    decrypt: () => credentials,
    forward: vi.fn(async () => new Response(null, { status: 200 })),
    list: vi.fn(async () => [{
      encryptedCredentials: "sealed",
      id: "source-1",
      organizationId: "org-1",
      state: {},
    }]),
    listShared: vi.fn(async () => []),
    now: () => new Date("2026-10-15T10:00:00Z"),
    sharedReader: () => null,
    update: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("pullGcpTelemetrySources", () => {
  it("sends each source's data to its project and saves the cursors", async () => {
    const deps = dependencies();

    expect(await pullGcpTelemetrySources(deps)).toEqual({ failed: 0, sources: 1 });
    expect(deps.forward).toHaveBeenCalledWith(expect.objectContaining({ contentType: "application/json", organizationId: "org-1", signal: "logs" }));
    expect(deps.update).toHaveBeenCalledWith("source-1", expect.objectContaining({
      lastError: null,
      lastReceivedAt: new Date("2026-10-15T10:00:00Z"),
      state: expect.objectContaining({ logsCursor: "2026-10-15T09:59:00.000Z" }),
      status: "active",
    }));
  });

  it("marks a source failed when nothing could be read", async () => {
    const deps = dependencies({ createRequest: () => async () => { throw new Error("Permission denied"); } });

    expect(await pullGcpTelemetrySources(deps)).toEqual({ failed: 1, sources: 1 });
    expect(deps.update).toHaveBeenCalledWith("source-1", expect.objectContaining({ lastError: expect.stringContaining("Permission denied"), status: "failed" }));
  });

  it("does nothing without a collector", async () => {
    const deps = dependencies({ collectorUrl: () => null });
    expect(await pullGcpTelemetrySources(deps)).toEqual({ failed: 0, sources: 0 });
    expect(deps.list).not.toHaveBeenCalled();
  });

  it("reads shared-reader sources' metrics with the shared reader", async () => {
    const sharedRequest = vi.fn(async (input: { url: string }) => {
      if (input.url.includes("entries:list")) throw new Error("logs must not be read");
      return {
        timeSeries: [{
          metric: { type: "run.googleapis.com/request_count" },
          points: [{ interval: { endTime: "2026-10-15T09:54:00Z" }, value: { int64Value: "3" } }],
          resource: { labels: { project_id: "shop-sandbox" }, type: "global" },
        }],
      };
    });
    const reader = {
      audience: "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/runtime/providers/aws-runtime",
      serviceAccount: "metrics-reader@operator-project.iam.gserviceaccount.com",
    };
    const createSharedRequest = vi.fn(() => sharedRequest);
    const deps = dependencies({
      createSharedRequest,
      list: vi.fn(async () => []),
      listShared: vi.fn(async () => [{ gcpProjectId: "shop-sandbox", id: "source-2", organizationId: "org-2", state: {} }]),
      sharedReader: () => reader,
    });

    expect(await pullGcpTelemetrySources(deps)).toEqual({ failed: 0, sources: 1 });
    expect(createSharedRequest).toHaveBeenCalledWith(reader);
    expect(sharedRequest).toHaveBeenCalledWith(expect.objectContaining({
      url: expect.stringContaining("/projects/shop-sandbox/timeSeries"),
    }));
    expect(deps.forward).toHaveBeenCalledWith(expect.objectContaining({ organizationId: "org-2", signal: "metrics" }));
    expect(deps.forward).not.toHaveBeenCalledWith(expect.objectContaining({ signal: "logs" }));
    expect(deps.update).toHaveBeenCalledWith("source-2", expect.objectContaining({ lastError: null, status: "active" }));
  });

  it("leaves shared-reader sources alone when no shared reader is configured", async () => {
    const deps = dependencies({ list: vi.fn(async () => []) });

    expect(await pullGcpTelemetrySources(deps)).toEqual({ failed: 0, sources: 0 });
    expect(deps.listShared).not.toHaveBeenCalled();
  });
});

function railwayDependencies(overrides: Partial<RailwayTelemetryPullDependencies> = {}): RailwayTelemetryPullDependencies {
  return {
    accessToken: vi.fn(async () => "railway-token"),
    collectorUrl: () => "http://collector:4318",
    forward: vi.fn(async () => new Response(null, { status: 200 })),
    list: vi.fn(async () => [{
      environmentId: "env-prod",
      id: "source-1",
      integrationAccountId: "account-1",
      organizationId: "org-1",
      state: { services: {} },
    }]),
    now: () => new Date("2026-11-13T10:00:00Z"),
    pull: vi.fn(async (input) => {
      await input.forward({ resourceLogs: [] });
      return { error: null, logs: 3, received: true, state: { logsCursor: "2026-11-13T09:59:40.000Z", services: {} }, truncated: false };
    }),
    update: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("pullRailwayTelemetrySources", () => {
  it("reads each environment with its connection's token and saves the cursor", async () => {
    const deps = railwayDependencies();

    expect(await pullRailwayTelemetrySources(deps)).toEqual({ failed: 0, sources: 1 });
    expect(deps.accessToken).toHaveBeenCalledWith({ integrationAccountId: "account-1", organizationId: "org-1" });
    expect(deps.pull).toHaveBeenCalledWith(expect.objectContaining({ accessToken: "railway-token", environmentId: "env-prod" }));
    expect(deps.forward).toHaveBeenCalledWith(expect.objectContaining({ organizationId: "org-1", signal: "logs" }));
    expect(deps.update).toHaveBeenCalledWith("source-1", {
      lastError: null,
      lastReceivedAt: new Date("2026-11-13T10:00:00Z"),
      state: { logsCursor: "2026-11-13T09:59:40.000Z", services: {} },
      status: "active",
    });
  });

  it("asks for a reconnect when Railway refuses the refresh", async () => {
    const deps = railwayDependencies({ accessToken: vi.fn(async () => { throw new McpOAuthRefreshError(true); }) });

    expect(await pullRailwayTelemetrySources(deps)).toEqual({ failed: 1, sources: 1 });
    expect(deps.pull).not.toHaveBeenCalled();
    expect(deps.update).toHaveBeenCalledWith("source-1", {
      lastError: "Railway refused the connection's access. Reconnect Railway.",
      status: "failed",
    });
  });

  it("skips a connection that is gone and does nothing without a collector", async () => {
    const gone = railwayDependencies({ accessToken: vi.fn(async () => null) });
    expect(await pullRailwayTelemetrySources(gone)).toEqual({ failed: 0, sources: 1 });
    expect(gone.pull).not.toHaveBeenCalled();
    expect(gone.update).not.toHaveBeenCalled();

    const noCollector = railwayDependencies({ collectorUrl: () => null });
    expect(await pullRailwayTelemetrySources(noCollector)).toEqual({ failed: 0, sources: 0 });
    expect(noCollector.list).not.toHaveBeenCalled();
  });
});
