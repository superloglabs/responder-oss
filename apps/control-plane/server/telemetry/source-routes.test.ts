import { describe, expect, it, vi } from "vitest";
import { VercelDrainError } from "../../../../packages/core/src/telemetry/sources/vercel-drains.js";
import { createSourceRoutes, type SourceRouteDependencies } from "./source-routes.js";

const organizationId = "b925b1df-5b78-43c8-a816-6f00afb174af";
const accountId = "3f1f2a1e-8d47-4a5e-9c55-0b0c3ad3b0aa";
const sourceId = "6a7f8c2b-2f3d-4f0e-8f8a-1b2c3d4e5f60";
const token = `sl_ingest_${"a".repeat(43)}`;

function routes(overrides: Partial<SourceRouteDependencies> = {}) {
  const dependencies: SourceRouteDependencies = {
    accounts: vi.fn(async () => [{ displayName: "Acme", id: accountId, provider: "vercel" as const }]),
    awsTemplateUrl: vi.fn(async () => "https://bucket.s3.eu-west-3.amazonaws.com/t.yaml?sig=1"),
    collectorUrl: () => "http://collector:4318",
    createKey: vi.fn(async (input) => ({
      key: { createdAt: "", id: "key-1", lastUsedAt: null, name: input.name, prefix: "sl_ingest_aaaaaa" },
      token,
    })),
    createVercelDrains: vi.fn(async () => ({ logs: "drn_logs", traces: "drn_traces" })),
    decrypt: vi.fn(() => ({ accessToken: "vercel-token", configurationId: "icfg_1", teamId: "team_1", userId: null })),
    deleteSource: vi.fn(async () => undefined),
    deleteVercelDrain: vi.fn(async () => undefined),
    getAccount: vi.fn(async () => ({ encryptedCredentials: "sealed", id: accountId, metadata: { projectSelection: "all" }, status: "connected" })),
    getSource: vi.fn(async () => null),
    hasTelemetry: vi.fn(async () => true),
    ingestOrigin: () => "https://eu.superlog.sh",
    listSources: vi.fn(async () => []),
    providerConfigured: () => true,
    revokeKey: vi.fn(async () => undefined),
    saveSource: vi.fn(async () => ({ id: sourceId, previousIngestKeyId: null, previousState: null })),
    tenant: vi.fn(async () => ({ ok: true as const, organizationId, role: "member", user: { id: "user-1" } })),
    vercelProjectIds: vi.fn(async () => ["prj_1"]),
    ...overrides,
  };
  return { app: createSourceRoutes(dependencies), dependencies };
}

function post(app: ReturnType<typeof routes>["app"], path: string, body: unknown) {
  return app.request(path, { body: JSON.stringify(body), headers: { "content-type": "application/json" }, method: "POST" });
}

describe("telemetry source routes", () => {
  it("lists sources, usable connections and configured providers", async () => {
    const { app } = routes();
    const response = await app.request("/");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      accounts: [{ displayName: "Acme", id: accountId, provider: "vercel" }],
      providers: { gcp: true, vercel: true },
      sources: [],
    });
  });

  it("is not there without telemetry", async () => {
    expect((await routes({ hasTelemetry: vi.fn(async () => false) }).app.request("/")).status).toBe(404);
    expect((await routes({ collectorUrl: () => null }).app.request("/")).status).toBe(404);
  });

  it("prepares an AWS stack with a new key", async () => {
    const { app, dependencies } = routes();

    const response = await post(app, "/aws", { region: "eu-west-1" });

    expect(response.status).toBe(201);
    const body = await response.json() as { deployCommand: string; launchUrl: string; stackName: string };
    expect(body.launchUrl).toContain("https://eu-west-1.console.aws.amazon.com/cloudformation/home?region=eu-west-1#/stacks/quickcreate?");
    expect(body.launchUrl).toContain(`param_IngestKey=${token}`);
    expect(body.deployCommand).toContain("IngestUrl=https://eu.superlog.sh");
    expect(dependencies.saveSource).toHaveBeenCalledWith(expect.objectContaining({
      ingestKeyId: "key-1",
      provider: "aws",
      state: expect.objectContaining({ region: "eu-west-1", stackName: body.stackName }),
      status: "pending",
    }));
    expect((await post(app, "/aws", { region: "us-gov-west-1" })).status).toBe(400);
  });

  it("offers the CLI command when no template bucket is configured", async () => {
    const { app } = routes({ awsTemplateUrl: vi.fn(async () => null) });
    const body = await (await post(app, "/aws", { region: "us-east-1" })).json() as { launchUrl: string | null };
    expect(body.launchUrl).toBeNull();
  });

  it("creates Vercel drains for the installation's selected projects and replaces earlier ones", async () => {
    const previous = {
      createdAt: "",
      displayName: "Vercel",
      externalId: "icfg_1",
      id: sourceId,
      integrationAccountId: accountId,
      lastError: null,
      lastReceivedAt: null,
      provider: "vercel" as const,
      state: { drains: { logs: "drn_old" }, staleDrains: ["drn_stale"] },
      status: "active" as const,
    };
    const { app, dependencies } = routes({
      getAccount: vi.fn(async () => ({ encryptedCredentials: "sealed", id: accountId, metadata: { projectSelection: "selected" }, status: "connected" })),
      listSources: vi.fn(async () => [previous]),
      saveSource: vi.fn(async () => ({ id: sourceId, previousIngestKeyId: "old-key", previousState: previous.state })),
    });

    expect((await post(app, "/vercel", { integrationAccountId: accountId })).status).toBe(201);
    expect(dependencies.createVercelDrains).toHaveBeenCalledWith({
      accessToken: "vercel-token",
      ingestKey: token,
      ingestOrigin: "https://eu.superlog.sh",
      name: `superlog-${organizationId.slice(0, 8)}`,
      projectIds: ["prj_1"],
      teamId: "team_1",
    });
    expect(dependencies.deleteVercelDrain).toHaveBeenCalledWith({ accessToken: "vercel-token", teamId: "team_1" }, "drn_old");
    expect(dependencies.deleteVercelDrain).toHaveBeenCalledWith({ accessToken: "vercel-token", teamId: "team_1" }, "drn_stale");
    expect(dependencies.saveSource).toHaveBeenCalledWith(expect.objectContaining({
      externalId: "icfg_1",
      state: { drains: { logs: "drn_logs", traces: "drn_traces" }, staleDrains: [] },
      status: "active",
    }));
    expect(dependencies.revokeKey).toHaveBeenCalledWith("old-key");
  });

  it("keeps earlier drains Vercel did not delete for a later retry", async () => {
    const { app, dependencies } = routes({
      deleteVercelDrain: vi.fn(async () => { throw new Error("Vercel returned HTTP 500"); }),
      listSources: vi.fn(async () => [{
        createdAt: "",
        displayName: "Vercel",
        externalId: "icfg_1",
        id: sourceId,
        integrationAccountId: accountId,
        lastError: null,
        lastReceivedAt: null,
        provider: "vercel" as const,
        state: { drains: { logs: "drn_old" } },
        status: "active" as const,
      }]),
    });

    expect((await post(app, "/vercel", { integrationAccountId: accountId })).status).toBe(201);
    expect(dependencies.saveSource).toHaveBeenCalledWith(expect.objectContaining({
      state: { drains: { logs: "drn_logs", traces: "drn_traces" }, staleDrains: ["drn_old"] },
    }));
  });

  it("explains a Vercel refusal and revokes the unused key", async () => {
    const { app, dependencies } = routes({
      createVercelDrains: vi.fn(async () => { throw new VercelDrainError("Forbidden", 403); }),
    });

    const response = await post(app, "/vercel", { integrationAccountId: accountId });

    expect(response.status).toBe(502);
    expect((await response.json() as { error: string }).error).toContain("Pro or Enterprise");
    expect(dependencies.revokeKey).toHaveBeenCalledWith("key-1");
    expect(dependencies.saveSource).not.toHaveBeenCalled();
  });

  it("reads a connected Google Cloud project without a key", async () => {
    const { app, dependencies } = routes({
      decrypt: vi.fn(() => ({ projectId: "shop-prod", projectNumber: "123456789", sessionName: `responder-gcp-${"a".repeat(32)}` })),
    });

    expect((await post(app, "/gcp", { integrationAccountId: accountId })).status).toBe(201);
    expect(dependencies.createKey).not.toHaveBeenCalled();
    expect(dependencies.saveSource).toHaveBeenCalledWith(expect.objectContaining({
      externalId: "shop-prod",
      integrationAccountId: accountId,
      provider: "gcp",
    }));

    const missing = routes({ getAccount: vi.fn(async () => null) as unknown as SourceRouteDependencies["getAccount"] });
    expect((await post(missing.app, "/gcp", { integrationAccountId: accountId })).status).toBe(404);
  });

  it("removes a Vercel source with its drains and key", async () => {
    const { app, dependencies } = routes({
      getSource: vi.fn(async () => ({
        createdAt: "",
        createdBy: "user-1",
        displayName: "Vercel",
        externalId: "icfg_1",
        id: sourceId,
        ingestKeyId: "key-1",
        integrationAccountId: accountId,
        lastError: null,
        lastReceivedAt: null,
        provider: "vercel" as const,
        state: { drains: { logs: "drn_logs", traces: "drn_traces" }, staleDrains: ["drn_stale"] },
        status: "active" as const,
      })),
    });

    expect((await app.request(`/${sourceId}`, { method: "DELETE" })).status).toBe(204);
    expect(dependencies.deleteVercelDrain).toHaveBeenCalledTimes(3);
    expect(dependencies.revokeKey).toHaveBeenCalledWith("key-1");
    expect(dependencies.deleteSource).toHaveBeenCalledWith({ id: sourceId, organizationId });
    expect((await routes().app.request(`/${sourceId}`, { method: "DELETE" })).status).toBe(404);
  });

  it("lets only the creator, owners and admins remove a source", async () => {
    const source = {
      createdAt: "",
      createdBy: "someone-else",
      displayName: "shop-prod",
      externalId: "shop-prod",
      id: sourceId,
      ingestKeyId: null,
      integrationAccountId: accountId,
      lastError: null,
      lastReceivedAt: null,
      provider: "gcp" as const,
      state: {},
      status: "active" as const,
    };
    const member = routes({ getSource: vi.fn(async () => source) });
    expect((await member.app.request(`/${sourceId}`, { method: "DELETE" })).status).toBe(403);
    expect(member.dependencies.deleteSource).not.toHaveBeenCalled();

    const admin = routes({
      getSource: vi.fn(async () => source),
      tenant: vi.fn(async () => ({ ok: true as const, organizationId, role: "admin", user: { id: "user-1" } })),
    });
    expect((await admin.app.request(`/${sourceId}`, { method: "DELETE" })).status).toBe(204);
  });

  it("serves the AWS template", async () => {
    const response = await routes().app.request("/aws/template");
    expect(response.headers.get("content-disposition")).toContain("superlog-aws-telemetry.yaml");
    expect(await response.text()).toContain("AWS::CloudWatch::MetricStream");
  });
});
