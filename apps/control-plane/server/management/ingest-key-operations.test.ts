import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { managementMcpRoutes } from "./mcp.js";
import { managementApiRoutes } from "./routes.js";

const organizationId = "15151515-1515-4515-8515-151515151515";
const userId = "21212121-2121-4121-8121-212121212121";
const apiKeyId = "31313131-3131-4131-8131-313131313131";
const keyId = "41414141-4141-4141-8141-414141414141";
const token = `slk_${"a".repeat(43)}`;
const ingestToken = `sl_ingest_${"b".repeat(43)}`;

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  capability: vi.fn(),
  collectorUrl: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
}));

vi.mock("../../../../packages/core/src/db/api-keys.js", () => ({
  authenticateApiKey: mocks.authenticate,
  listApiKeys: vi.fn().mockResolvedValue([]),
  revokeApiKey: vi.fn(),
}));
vi.mock("../../../../packages/core/src/db/oauth-access-tokens.js", () => ({
  authenticateOAuthAccessToken: vi.fn(),
}));
vi.mock("../../../../packages/core/src/db/organization-capabilities.js", () => ({
  listEnabledOrganizationCapabilities: vi.fn().mockResolvedValue([]),
  organizationHasCapability: mocks.capability,
}));
vi.mock("../../../../packages/core/src/db/telemetry-ingest-keys.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createTelemetryIngestKey: mocks.create,
  listTelemetryIngestKeys: mocks.list,
}));
vi.mock("../../../../packages/core/src/telemetry/client.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  telemetryCollectorUrl: mocks.collectorUrl,
}));

const app = new Hono()
  .route("/api/v1", managementApiRoutes)
  .route("/api/mcp", managementMcpRoutes);

async function mcp(method: string, params?: Record<string, unknown>) {
  const response = await app.request("/api/mcp", {
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, ...(params ? { params } : {}) }),
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
  return ((await response.json()) as { result: Record<string, unknown> }).result;
}

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const result = await mcp("tools/call", { arguments: args, name }) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  return { body: JSON.parse(result.content[0]!.text) as Record<string, unknown>, isError: result.isError };
}

const key = {
  createdAt: "2026-10-29T12:00:00.000Z",
  id: keyId,
  lastUsedAt: null,
  name: "checkout-api production",
  prefix: "sl_ingest_bbbb",
};

describe("ingest key operations", () => {
  beforeEach(() => {
    mocks.authenticate.mockResolvedValue({
      apiKeyId,
      organizationId,
      role: "member",
      user: { email: "ash@example.com", id: userId, name: "Ash" },
    });
    mocks.capability.mockImplementation(async (_organization: string, capability: string) => capability === "telemetry");
    mocks.collectorUrl.mockReturnValue("http://collector.telemetry.internal:4318");
    mocks.list.mockResolvedValue([key]);
    mocks.create.mockResolvedValue({ key, token: ingestToken });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("marks listing as read-only and creating as a write", async () => {
    const { tools } = await mcp("tools/list") as {
      tools: Array<{ annotations: Record<string, unknown>; name: string }>;
    };
    const annotations = (name: string) => tools.find((tool) => tool.name === name)?.annotations;

    expect(annotations("list_ingest_keys")).toMatchObject({ readOnlyHint: true });
    expect(annotations("create_ingest_key")).toMatchObject({ readOnlyHint: false });
  });

  it("lists keys without their values", async () => {
    const { body } = await callTool("list_ingest_keys");

    expect(body).toEqual({ endpoint: "http://localhost:3000/api/ingest", keys: [key] });
    expect(mocks.list).toHaveBeenCalledWith(organizationId);
  });

  it("creates a key as the caller and returns its SDK settings once", async () => {
    const { body } = await callTool("create_ingest_key", { name: "checkout-api production" });

    expect(body).toEqual({
      endpoint: "http://localhost:3000/api/ingest",
      environment: {
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:3000/api/ingest",
        OTEL_EXPORTER_OTLP_HEADERS: `x-api-key=${ingestToken}`,
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
      },
      key,
      token: ingestToken,
    });
    expect(mocks.create).toHaveBeenCalledWith({ createdBy: userId, name: "checkout-api production", organizationId });
  });

  it("answers 201 from the REST API", async () => {
    const response = await app.request("/api/v1/ingest-keys", {
      body: JSON.stringify({ name: "web" }),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(201);
  });

  it("is not available without telemetry or a collector", async () => {
    mocks.capability.mockResolvedValue(false);
    expect(await callTool("create_ingest_key", { name: "web" })).toMatchObject({
      body: { code: "telemetry_unavailable" },
      isError: true,
    });

    mocks.capability.mockResolvedValue(true);
    mocks.collectorUrl.mockReturnValue(null);
    expect(await callTool("list_ingest_keys")).toMatchObject({ body: { code: "telemetry_unavailable" }, isError: true });
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
