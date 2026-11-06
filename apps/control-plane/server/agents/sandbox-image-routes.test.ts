import { describe, expect, it, vi } from "vitest";
import { createSandboxImageRoutes } from "./sandbox-image-routes.js";
import {
  defaultSandboxImageSettings,
  type SandboxImageRecord,
  type SandboxImageSettings,
} from "../../../../packages/core/src/sandbox-image.js";

const organizationId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";

const playwright: SandboxImageSettings = {
  packages: ["nss", "atk"],
  setupScript: "npx -y playwright install chromium",
  startCommand: "",
  vcpus: 4,
};

function setup(input: {
  image?: SandboxImageRecord | null;
  provider?: "daytona" | "vercel";
  requestedAt?: Date | null;
  role?: string;
  settings?: SandboxImageSettings;
} = {}) {
  const deps: NonNullable<Parameters<typeof createSandboxImageRoutes>[0]> = {
    getImage: vi.fn(async () => input.image ?? null),
    getRequestedAt: vi.fn(async () => input.requestedAt ?? null),
    getSettings: vi.fn(async () => input.settings ?? defaultSandboxImageSettings),
    provider: () => input.provider ?? "vercel",
    queueBuild: vi.fn(async () => {}),
    requestRebuild: vi.fn(async () => {}),
    save: vi.fn(async () => {}),
    tenant: vi.fn(async () => ({
      ok: true as const,
      organizationId,
      role: input.role ?? "admin",
      user: { email: "ash@example.com", id: userId, name: "Ash" },
    })),
  };
  return { app: createSandboxImageRoutes(deps), deps };
}

function put(app: ReturnType<typeof createSandboxImageRoutes>, body: unknown) {
  return app.request("/", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "PUT",
  });
}

describe("sandbox settings", () => {
  it("shows members the settings without editing", async () => {
    const { app } = setup({ role: "member" });
    const body = await (await app.request("/")).json() as { canEdit: boolean; image: { state: string } };
    expect(body.canEdit).toBe(false);
    expect(body.image.state).toBe("none");
  });

  it("saves new packages and queues a build", async () => {
    const { app, deps } = setup();
    const response = await put(app, playwright);
    expect(response.status).toBe(200);
    expect(deps.save).toHaveBeenCalledWith(organizationId, playwright, userId, true);
    expect(deps.queueBuild).toHaveBeenCalledWith(organizationId);
  });

  it("changes the size without a build", async () => {
    const { app, deps } = setup({ settings: playwright });
    await put(app, { ...playwright, vcpus: 8 });
    expect(deps.save).toHaveBeenCalledWith(organizationId, { ...playwright, vcpus: 8 }, userId, false);
    expect(deps.queueBuild).not.toHaveBeenCalled();
  });

  it("queues the image job to record a new start command with the snapshot", async () => {
    const { app, deps } = setup({ settings: playwright });
    const next = { ...playwright, startCommand: "sudo dockerd >/tmp/dockerd.log 2>&1 &" };
    await put(app, next);
    expect(deps.save).toHaveBeenCalledWith(organizationId, next, userId, true);
    expect(deps.queueBuild).toHaveBeenCalledWith(organizationId);
  });

  it("changes the start command right away when there is no image", async () => {
    const { app, deps } = setup();
    const next = { ...defaultSandboxImageSettings, startCommand: "echo up" };
    await put(app, next);
    expect(deps.save).toHaveBeenCalledWith(organizationId, next, userId, false);
    expect(deps.queueBuild).not.toHaveBeenCalled();
  });

  it("rejects invalid settings", async () => {
    const { app, deps } = setup();
    expect((await put(app, { ...playwright, vcpus: 3 })).status).toBe(400);
    expect(deps.save).not.toHaveBeenCalled();
  });

  it("only lets admins ask for a rebuild", async () => {
    const { app, deps } = setup({ role: "member", settings: playwright });
    expect((await app.request("/rebuild", { method: "POST" })).status).toBe(403);
    expect(deps.queueBuild).not.toHaveBeenCalled();
  });

  it("shows a build as queued until the worker starts it", async () => {
    const { app } = setup({
      image: {
        error: null,
        finishedAt: new Date("2026-11-03T12:00:00Z"),
        key: "k",
        log: "",
        snapshotBaseId: "snap_base",
        snapshotBuiltAt: new Date("2026-11-03T12:00:00Z"),
        snapshotId: "snap_workspace",
        snapshotKey: "k",
        snapshotRegion: "cdg1",
        snapshotStartCommand: "",
        startedAt: new Date("2026-11-03T11:55:00Z"),
        status: "ready",
      },
      requestedAt: new Date("2026-11-03T13:00:00Z"),
      settings: playwright,
    });
    const body = await (await app.request("/")).json() as { image: { state: string } };
    expect(body.image.state).toBe("queued");
  });

  it("only lets admins save", async () => {
    const { app, deps } = setup({ role: "member" });
    expect((await put(app, playwright)).status).toBe(403);
    expect(deps.save).not.toHaveBeenCalled();
  });

  it("refuses settings on Daytona", async () => {
    const { app, deps } = setup({ provider: "daytona" });
    expect((await put(app, playwright)).status).toBe(409);
    expect(deps.save).not.toHaveBeenCalled();
  });

  it("forces a rebuild on request", async () => {
    const { app, deps } = setup({ settings: playwright });
    const response = await app.request("/rebuild", { method: "POST" });
    expect(response.status).toBe(200);
    expect(deps.requestRebuild).toHaveBeenCalledWith(organizationId);
    expect(deps.queueBuild).toHaveBeenCalledWith(organizationId);
  });

  it("queues a build that deletes the image when the packages and script are cleared", async () => {
    const { app, deps } = setup({ settings: playwright });
    const cleared = { ...defaultSandboxImageSettings, vcpus: 4 };
    expect((await put(app, cleared)).status).toBe(200);
    expect(deps.save).toHaveBeenCalledWith(organizationId, cleared, userId, true);
    expect(deps.queueBuild).toHaveBeenCalledWith(organizationId);
  });

  it("refuses a rebuild when there is nothing to build", async () => {
    const { app, deps } = setup();
    expect((await app.request("/rebuild", { method: "POST" })).status).toBe(400);
    expect(deps.queueBuild).not.toHaveBeenCalled();
  });
});
