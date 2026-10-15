import { describe, expect, it, vi } from "vitest";
import { type GcpTelemetryPullDependencies, pullGcpTelemetrySources } from "./telemetry-sources.js";

const credentials = { projectId: "shop-prod", projectNumber: "123456789", sessionName: `responder-gcp-${"a".repeat(32)}` };

function dependencies(overrides: Partial<GcpTelemetryPullDependencies> = {}): GcpTelemetryPullDependencies {
  return {
    collectorUrl: () => "http://collector:4318",
    createRequest: () => async (input) =>
      input.url.includes("entries:list")
        ? { entries: [{ resource: { type: "global" }, textPayload: "hi", timestamp: "2026-10-15T09:58:00Z" }] }
        : { timeSeries: [] },
    decrypt: () => credentials,
    forward: vi.fn(async () => new Response(null, { status: 200 })),
    list: vi.fn(async () => [{
      encryptedCredentials: "sealed",
      id: "source-1",
      organizationId: "org-1",
      state: {},
    }]),
    now: () => new Date("2026-10-15T10:00:00Z"),
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
});
