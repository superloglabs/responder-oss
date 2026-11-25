import { describe, expect, it, vi } from "vitest";
import { McpOAuthRefreshError } from "../../../../packages/core/src/integrations/custom-mcp.js";
import { PostHogApiError } from "../../../../packages/core/src/integrations/posthog-api.js";
import { RenderApiError } from "../../../../packages/core/src/integrations/render.js";
import { VercelDrainError } from "../../../../packages/core/src/telemetry/sources/vercel-drains.js";
import { createSourceRoutes, type SourceRouteDependencies } from "./source-routes.js";
import { createVercelSourceAfterConnect, removeVercelSourcesBeforeDisconnect } from "./vercel-sources.js";

const organizationId = "b925b1df-5b78-43c8-a816-6f00afb174af";
const accountId = "3f1f2a1e-8d47-4a5e-9c55-0b0c3ad3b0aa";
const sourceId = "6a7f8c2b-2f3d-4f0e-8f8a-1b2c3d4e5f60";
const token = `sl_ingest_${"a".repeat(43)}`;
const railwayEnvironment = {
  environmentId: "env-prod",
  environmentName: "production",
  projectId: "project-1",
  projectName: "shop",
  workspaceId: "workspace-1",
  workspaceName: "Acme",
};

const postHogProject = { id: "12345", name: "Web app", organizationName: "Acme" };
const renderWorkspace = { id: "tea-example", kind: "workspace" as const, ownerId: "tea-example", workspaceName: "Example Team" };
const renderService = {
  id: "srv-web",
  kind: "service" as const,
  ownerId: "tea-example",
  region: "oregon",
  serviceName: "web",
  serviceType: "web_service",
  workspaceName: "Example Team",
};

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
    receivesTelemetry: vi.fn(async () => true),
    ingestOrigin: () => "https://eu.superlog.sh",
    listSources: vi.fn(async () => []),
    postHogProjects: vi.fn(async () => ({ host: "https://eu.posthog.com" as const, projects: [postHogProject] })),
    providerConfigured: () => true,
    railwayEnvironments: vi.fn(async () => [railwayEnvironment]),
    renderReadables: vi.fn(async () => [renderWorkspace, renderService]),
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
      providers: { gcp: true, posthog: true, railway: true, render: true, vercel: true },
      sources: [],
    });
  });

  it("is not there for a workspace without telemetry or Signal", async () => {
    const unavailable = await routes({ receivesTelemetry: vi.fn(async () => false) }).app.request(`/railway/${accountId}`);
    expect(unavailable.status).toBe(404);
    expect(await unavailable.json()).toEqual({ code: "telemetry_unavailable", error: "Sending telemetry is not available" });
    expect((await routes({ receivesTelemetry: vi.fn(async () => false) }).app.request("/")).status).toBe(404);
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

  it("removes new Vercel drains and their key when the source cannot be saved", async () => {
    const { app, dependencies } = routes({ saveSource: vi.fn(async () => { throw new Error("database unavailable"); }) });

    expect((await post(app, "/vercel", { integrationAccountId: accountId })).status).toBe(500);
    expect(dependencies.deleteVercelDrain).toHaveBeenCalledWith({ accessToken: "vercel-token", teamId: "team_1" }, "drn_traces");
    expect(dependencies.deleteVercelDrain).toHaveBeenCalledWith({ accessToken: "vercel-token", teamId: "team_1" }, "drn_logs");
    expect(dependencies.revokeKey).toHaveBeenCalledWith("key-1");
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

  describe("after Vercel connects from Signal setup", () => {
    const input = { integrationAccountId: accountId, organizationId, userId: "user-1" };

    it("creates the drains", async () => {
      const { dependencies } = routes();
      expect(await createVercelSourceAfterConnect(input, dependencies)).toBe("created");
      expect(dependencies.createVercelDrains).toHaveBeenCalledWith(expect.objectContaining({
        accessToken: "vercel-token",
        ingestKey: token,
        ingestOrigin: "https://eu.superlog.sh",
        projectIds: null,
        teamId: "team_1",
      }));
      expect(dependencies.saveSource).toHaveBeenCalledWith(expect.objectContaining({
        integrationAccountId: accountId,
        provider: "vercel",
        state: { drains: { logs: "drn_logs", traces: "drn_traces" }, staleDrains: [] },
      }));
    });

    it("leaves drains the connection already has", async () => {
      const { dependencies } = routes({
        listSources: vi.fn(async () => [{
          createdAt: "", displayName: "Vercel", externalId: "icfg_1", id: sourceId, integrationAccountId: accountId,
          lastError: null, lastReceivedAt: null, provider: "vercel" as const, state: {}, status: "active" as const,
        }]),
      });
      expect(await createVercelSourceAfterConnect(input, dependencies)).toBe("exists");
      expect(dependencies.createVercelDrains).not.toHaveBeenCalled();
    });

    it("creates nothing where the workspace cannot receive telemetry", async () => {
      const { dependencies } = routes({ receivesTelemetry: vi.fn(async () => false) });
      expect(await createVercelSourceAfterConnect(input, dependencies)).toBe("unavailable");
      expect(dependencies.createKey).not.toHaveBeenCalled();
    });

    it("reports a refusal and revokes the unused key", async () => {
      const { dependencies } = routes({
        createVercelDrains: vi.fn(async () => { throw new VercelDrainError("Forbidden", 403); }),
      });
      expect(await createVercelSourceAfterConnect(input, dependencies)).toBe("failed");
      expect(dependencies.revokeKey).toHaveBeenCalledWith("key-1");
      expect(dependencies.saveSource).not.toHaveBeenCalled();
    });
  });

  describe("before a Vercel connection is removed", () => {
    const vercelSource = {
      createdAt: "",
      displayName: "Vercel",
      externalId: "icfg_1",
      id: sourceId,
      integrationAccountId: accountId,
      lastError: null,
      lastReceivedAt: null,
      provider: "vercel" as const,
      state: { drains: { logs: "drn_logs", traces: "drn_traces" }, staleDrains: [] },
      status: "active" as const,
    };
    const withSource = (overrides: Partial<SourceRouteDependencies> = {}) => routes({
      getSource: vi.fn(async () => ({ ...vercelSource, createdBy: "user-1", ingestKeyId: "key-1" })),
      listSources: vi.fn(async () => [
        vercelSource,
        { ...vercelSource, id: "other-source", integrationAccountId: "other-connection" },
      ]),
      ...overrides,
    }).dependencies;
    const input = { integrationAccountId: accountId, organizationId };

    it("deletes the connection's drains, revokes their key, and removes its source", async () => {
      const dependencies = withSource();
      expect(await removeVercelSourcesBeforeDisconnect(input, dependencies)).toEqual({ ok: true });
      expect(dependencies.deleteVercelDrain).toHaveBeenCalledTimes(2);
      expect(dependencies.deleteVercelDrain).toHaveBeenCalledWith({ accessToken: "vercel-token", teamId: "team_1" }, "drn_logs");
      expect(dependencies.revokeKey).toHaveBeenCalledWith("key-1");
      expect(dependencies.deleteSource).toHaveBeenCalledTimes(1);
      expect(dependencies.deleteSource).toHaveBeenCalledWith({ id: sourceId, organizationId });
    });

    it("keeps the source while Vercel keeps a drain", async () => {
      const dependencies = withSource({
        deleteVercelDrain: vi.fn(async () => { throw new VercelDrainError("Vercel is down", 500); }),
      });
      expect(await removeVercelSourcesBeforeDisconnect(input, dependencies)).toEqual({
        error: "Vercel could not remove the drains: Vercel is down",
        ok: false,
      });
      expect(dependencies.revokeKey).not.toHaveBeenCalled();
      expect(dependencies.deleteSource).not.toHaveBeenCalled();
    });

    it("removes the source when Vercel no longer accepts the token", async () => {
      const dependencies = withSource({
        deleteVercelDrain: vi.fn(async () => { throw new VercelDrainError("Not authorized", 403); }),
      });
      expect(await removeVercelSourcesBeforeDisconnect(input, dependencies)).toEqual({ ok: true });
      expect(dependencies.revokeKey).toHaveBeenCalledWith("key-1");
      expect(dependencies.deleteSource).toHaveBeenCalled();
    });

    it("does nothing for a connection without drains", async () => {
      const dependencies = routes().dependencies;
      expect(await removeVercelSourcesBeforeDisconnect(input, dependencies)).toEqual({ ok: true });
      expect(dependencies.deleteVercelDrain).not.toHaveBeenCalled();
    });
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

  it("lists a Railway connection's environments and the ones it reads", async () => {
    const reading = {
      createdAt: "",
      displayName: "shop · production",
      externalId: "env-prod",
      id: sourceId,
      integrationAccountId: accountId,
      lastError: null,
      lastReceivedAt: null,
      provider: "railway" as const,
      state: {},
      status: "pending" as const,
    };
    const other = { ...reading, id: "other", integrationAccountId: "another-connection" };
    const { app, dependencies } = routes({ listSources: vi.fn(async () => [reading, other]) });
    const response = await app.request(`/railway/${accountId}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ environments: [railwayEnvironment], sources: [reading] });
    expect(dependencies.railwayEnvironments).toHaveBeenCalledWith({ integrationAccountId: accountId, organizationId });
  });

  it("reads a Railway environment the connection shares, without a key", async () => {
    const { app, dependencies } = routes();
    const response = await post(app, "/railway", { environmentId: "env-prod", integrationAccountId: accountId });
    expect(response.status).toBe(201);
    expect(dependencies.createKey).not.toHaveBeenCalled();
    expect(dependencies.saveSource).toHaveBeenCalledWith({
      createdBy: "user-1",
      displayName: "shop · production",
      externalId: "env-prod",
      integrationAccountId: accountId,
      organizationId,
      provider: "railway",
      state: {
        environmentName: "production",
        projectId: "project-1",
        projectName: "shop",
        services: {},
        workspaceId: "workspace-1",
      },
      status: "pending",
    });

    const unshared = await post(app, "/railway", { environmentId: "env-other", integrationAccountId: accountId });
    expect(unshared.status).toBe(404);
    expect(dependencies.saveSource).toHaveBeenCalledTimes(1);
  });

  it("keeps an environment that is already read as it is", async () => {
    const reading = {
      createdAt: "",
      displayName: "shop · production",
      externalId: "env-prod",
      id: sourceId,
      integrationAccountId: accountId,
      lastError: null,
      lastReceivedAt: "2026-11-13T10:00:00.000Z",
      provider: "railway" as const,
      state: { logsCursor: "2026-11-13T09:59:40.000Z" },
      status: "active" as const,
    };
    const { app, dependencies } = routes({ listSources: vi.fn(async () => [reading]) });
    const response = await post(app, "/railway", { environmentId: "env-prod", integrationAccountId: accountId });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sourceId });
    expect(dependencies.saveSource).not.toHaveBeenCalled();

    // Added from another connection, it moves there and keeps its cursor.
    const moved = routes({ listSources: vi.fn(async () => [{ ...reading, integrationAccountId: "old-connection" }]) });
    const response2 = await post(moved.app, "/railway", { environmentId: "env-prod", integrationAccountId: accountId });
    expect(response2.status).toBe(200);
    expect(moved.dependencies.saveSource).toHaveBeenCalledWith(expect.objectContaining({
      integrationAccountId: accountId,
      state: expect.objectContaining({ logsCursor: "2026-11-13T09:59:40.000Z", projectName: "shop" }),
      status: "active",
    }));
  });

  it("asks to connect or reconnect Railway when its environments cannot be read", async () => {
    const missing = routes({ railwayEnvironments: vi.fn(async () => null) });
    expect((await missing.app.request(`/railway/${accountId}`)).status).toBe(404);

    const refused = routes({
      railwayEnvironments: vi.fn(async () => { throw new McpOAuthRefreshError(true); }),
    });
    const response = await refused.app.request(`/railway/${accountId}`);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Railway refused the connection's access. Reconnect Railway." });

    const failing = routes({ railwayEnvironments: vi.fn(async () => { throw new Error("Railway API error: slow down"); }) });
    expect((await post(failing.app, "/railway", { environmentId: "env-prod", integrationAccountId: accountId })).status).toBe(502);
    expect(failing.dependencies.saveSource).not.toHaveBeenCalled();
  });

  it("lists what a Render key reads and the sources Superlog reads with it", async () => {
    const reading = {
      createdAt: "",
      displayName: "Example Team · web",
      externalId: "srv-web",
      id: sourceId,
      integrationAccountId: accountId,
      lastError: null,
      lastReceivedAt: null,
      provider: "render" as const,
      state: {},
      status: "pending" as const,
    };
    const { app } = routes({ listSources: vi.fn(async () => [reading, { ...reading, integrationAccountId: "other", id: "other" }]) });

    const response = await app.request(`/render/${accountId}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ readables: [renderWorkspace, renderService], sources: [reading] });
  });

  it("reads a Render service or a whole workspace with the connection's key, without an ingest key", async () => {
    const { app, dependencies } = routes();

    expect((await post(app, "/render", { integrationAccountId: accountId, resourceId: "srv-web" })).status).toBe(201);
    expect(dependencies.createKey).not.toHaveBeenCalled();
    expect(dependencies.saveSource).toHaveBeenCalledWith({
      createdBy: "user-1",
      displayName: "Example Team · web",
      externalId: "srv-web",
      integrationAccountId: accountId,
      organizationId,
      provider: "render",
      state: {
        cursors: {},
        kind: "service",
        ownerId: "tea-example",
        region: "oregon",
        serviceName: "web",
        serviceType: "web_service",
        services: {},
        workspaceName: "Example Team",
      },
      status: "pending",
    });

    expect((await post(app, "/render", { integrationAccountId: accountId, resourceId: "tea-example" })).status).toBe(201);
    expect(dependencies.saveSource).toHaveBeenLastCalledWith(expect.objectContaining({
      displayName: "Example Team · All services",
      externalId: "tea-example",
      state: { cursors: {}, kind: "workspace", ownerId: "tea-example", services: {}, workspaceName: "Example Team" },
    }));

    expect((await post(app, "/render", { integrationAccountId: accountId, resourceId: "srv-elsewhere" })).status).toBe(404);
    expect(dependencies.saveSource).toHaveBeenCalledTimes(2);
  });

  it("keeps a Render source's cursors when another connection adds it", async () => {
    const reading = {
      createdAt: "",
      displayName: "Example Team · web",
      externalId: "srv-web",
      id: sourceId,
      integrationAccountId: "old-connection",
      lastError: null,
      lastReceivedAt: null,
      provider: "render" as const,
      state: { cursors: { "srv-web": { ids: [], ts: "2026-11-25T09:59:40.000Z" } } },
      status: "active" as const,
    };
    const { app, dependencies } = routes({ listSources: vi.fn(async () => [reading]) });

    expect((await post(app, "/render", { integrationAccountId: accountId, resourceId: "srv-web" })).status).toBe(200);
    expect(dependencies.saveSource).toHaveBeenCalledWith(expect.objectContaining({
      integrationAccountId: accountId,
      state: expect.objectContaining({ cursors: { "srv-web": { ids: [], ts: "2026-11-25T09:59:40.000Z" } } }),
      status: "active",
    }));
  });

  it("says why a Render key's services could not be listed", async () => {
    expect((await routes({ renderReadables: vi.fn(async () => null) }).app.request(`/render/${accountId}`)).status).toBe(404);

    const refused = await routes({
      renderReadables: vi.fn(async () => { throw new RenderApiError("Render answered 401: unauthorized", "unauthorized", 401); }),
    }).app.request(`/render/${accountId}`);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "Render refused the API key. Connect Render again with a new key." });

    const limited = await routes({
      renderReadables: vi.fn(async () => { throw new RenderApiError("Render answered 429: rate limit exceeded", "retry_later", 429); }),
    }).app.request(`/render/${accountId}`);
    expect(limited.status).toBe(429);

    const failing = routes({ renderReadables: vi.fn(async () => { throw new Error("socket hang up"); }) });
    expect((await post(failing.app, "/render", { integrationAccountId: accountId, resourceId: "srv-web" })).status).toBe(502);
    expect(failing.dependencies.saveSource).not.toHaveBeenCalled();
  });

  it("lists a PostHog connection's projects and the ones it reads", async () => {
    const reading = {
      createdAt: "",
      displayName: "Acme · Web app",
      externalId: "12345",
      id: sourceId,
      integrationAccountId: accountId,
      lastError: null,
      lastReceivedAt: null,
      provider: "posthog" as const,
      state: {},
      status: "pending" as const,
    };
    const railway = { ...reading, id: "railway", provider: "railway" as const };
    const { app, dependencies } = routes({ listSources: vi.fn(async () => [reading, railway]) });
    const response = await app.request(`/posthog/${accountId}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ projects: [postHogProject], sources: [reading] });
    expect(dependencies.postHogProjects).toHaveBeenCalledWith({ integrationAccountId: accountId, organizationId });
  });

  it("reads a PostHog project the connection reaches, in its region and without a key", async () => {
    const { app, dependencies } = routes();
    const response = await post(app, "/posthog", { integrationAccountId: accountId, projectId: "12345" });
    expect(response.status).toBe(201);
    expect(dependencies.createKey).not.toHaveBeenCalled();
    expect(dependencies.saveSource).toHaveBeenCalledWith({
      createdBy: "user-1",
      displayName: "Acme · Web app",
      externalId: "12345",
      integrationAccountId: accountId,
      organizationId,
      provider: "posthog",
      state: { host: "https://eu.posthog.com", organizationName: "Acme", projectName: "Web app" },
      status: "pending",
    });

    expect((await post(app, "/posthog", { integrationAccountId: accountId, projectId: "999" })).status).toBe(404);
    expect((await post(app, "/posthog", { integrationAccountId: accountId, projectId: "../users" })).status).toBe(400);
    expect(dependencies.saveSource).toHaveBeenCalledTimes(1);
  });

  it("asks to connect or reconnect PostHog when its projects cannot be read", async () => {
    const missing = routes({ postHogProjects: vi.fn(async () => null) });
    expect((await missing.app.request(`/posthog/${accountId}`)).status).toBe(404);

    for (const error of [new McpOAuthRefreshError(true), new PostHogApiError(401, "PostHog API request failed (HTTP 401)")]) {
      const refused = routes({ postHogProjects: vi.fn(async () => { throw error; }) });
      const response = await refused.app.request(`/posthog/${accountId}`);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "PostHog refused the connection's access. Reconnect PostHog." });
    }

    const failing = routes({ postHogProjects: vi.fn(async () => { throw new Error("socket hang up"); }) });
    expect((await post(failing.app, "/posthog", { integrationAccountId: accountId, projectId: "12345" })).status).toBe(502);
    expect(failing.dependencies.saveSource).not.toHaveBeenCalled();
  });

  it("serves the AWS template", async () => {
    const response = await routes().app.request("/aws/template");
    expect(response.headers.get("content-disposition")).toContain("superlog-aws-telemetry.yaml");
    expect(await response.text()).toContain("AWS::CloudWatch::MetricStream");
  });
});
