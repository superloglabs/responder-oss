import { Hono } from "hono";
import {
  getSandboxImage,
  getSandboxImageRequestedAt,
  getSandboxImageSettings,
  requestSandboxImageRebuild,
  saveSandboxImageSettings,
} from "../../../../packages/core/src/db/sandbox-image.js";
import { sandboxProvider } from "../../../../packages/core/src/sandbox-config.js";
import {
  sandboxImageRequired,
  sandboxImageSettingsSchema,
  sandboxMemoryGiBPerVcpu,
  sandboxVcpuOptions,
  type SandboxImageRecord,
  type SandboxImageSettings,
} from "../../../../packages/core/src/sandbox-image.js";
import { queueSandboxImageBuild } from "../automations/queue.js";
import { getActiveTenant } from "../tenant.js";

// Members can see what a workspace's sandboxes contain. Only owners and
// admins change it, because the setup script and start command run in every
// agent's sandbox.

const defaults = {
  getImage: getSandboxImage,
  getRequestedAt: getSandboxImageRequestedAt,
  getSettings: getSandboxImageSettings,
  provider: () => sandboxProvider(),
  queueBuild: queueSandboxImageBuild,
  requestRebuild: requestSandboxImageRebuild,
  save: saveSandboxImageSettings,
  tenant: getActiveTenant,
};

function isWorkspaceAdmin(role: string): boolean {
  return role.split(",").some((value) => ["owner", "admin"].includes(value.trim()));
}

function imageChanged(previous: SandboxImageSettings, next: SandboxImageSettings): boolean {
  return previous.setupScript !== next.setupScript ||
    [...previous.packages].sort().join("\n") !== [...next.packages].sort().join("\n");
}

type ImageState = "building" | "failed" | "none" | "queued" | "ready";

function imageState(
  settings: SandboxImageSettings,
  image: SandboxImageRecord | null,
  requestedAt: Date | null,
): ImageState {
  if (!sandboxImageRequired(settings)) return "none";
  if (!image || (requestedAt && image.startedAt < requestedAt)) return "queued";
  return image.status;
}

export function createSandboxImageRoutes(deps = defaults) {
  async function presented(organizationId: string, role: string) {
    const [settings, image, requestedAt] = await Promise.all([
      deps.getSettings(organizationId),
      deps.getImage(organizationId),
      deps.getRequestedAt(organizationId),
    ]);
    return {
      canEdit: isWorkspaceAdmin(role),
      image: {
        builtAt: image?.snapshotBuiltAt?.toISOString() ?? null,
        error: image?.error ?? null,
        finishedAt: image?.finishedAt?.toISOString() ?? null,
        log: image?.log ?? "",
        startedAt: image?.startedAt.toISOString() ?? null,
        state: imageState(settings, image, requestedAt),
      },
      memoryGiBPerVcpu: sandboxMemoryGiBPerVcpu,
      settings,
      // Workspace sandbox settings apply on the Vercel provider only.
      supported: deps.provider() === "vercel",
      vcpuOptions: sandboxVcpuOptions,
    };
  }

  return new Hono()
    .get("/", async (context) => {
      const tenant = await deps.tenant(context.req.raw.headers);
      if (!tenant.ok) return context.json({ error: tenant.error }, tenant.status);
      return context.json(
        await presented(tenant.organizationId, tenant.role),
        200,
        { "cache-control": "no-store" },
      );
    })
    .put("/", async (context) => {
      const tenant = await deps.tenant(context.req.raw.headers);
      if (!tenant.ok) return context.json({ error: tenant.error }, tenant.status);
      if (!isWorkspaceAdmin(tenant.role)) {
        return context.json({ error: "Workspace administrator access required" }, 403);
      }
      if (deps.provider() !== "vercel") {
        return context.json({ error: "Sandbox settings need the Vercel sandbox provider" }, 409);
      }
      const parsed = sandboxImageSettingsSchema.safeParse(
        await context.req.json().catch(() => null),
      );
      if (!parsed.success) {
        return context.json(
          { error: parsed.error.issues[0]?.message ?? "Invalid sandbox settings" },
          400,
        );
      }
      const previous = await deps.getSettings(tenant.organizationId);
      const changed = imageChanged(previous, parsed.data);
      await deps.save(tenant.organizationId, parsed.data, tenant.user.id, changed);
      // Clearing the packages and script also queues a job, which deletes
      // the workspace's snapshot. The settings are saved first, so the
      // worker's maintenance pass queues the build if this request fails.
      if (changed) await deps.queueBuild(tenant.organizationId);
      return context.json(await presented(tenant.organizationId, tenant.role));
    })
    .post("/rebuild", async (context) => {
      const tenant = await deps.tenant(context.req.raw.headers);
      if (!tenant.ok) return context.json({ error: tenant.error }, tenant.status);
      if (!isWorkspaceAdmin(tenant.role)) {
        return context.json({ error: "Workspace administrator access required" }, 403);
      }
      if (deps.provider() !== "vercel") {
        return context.json({ error: "Sandbox settings need the Vercel sandbox provider" }, 409);
      }
      const settings = await deps.getSettings(tenant.organizationId);
      if (!sandboxImageRequired(settings)) {
        return context.json({ error: "Add packages or a setup script first" }, 400);
      }
      await deps.requestRebuild(tenant.organizationId);
      await deps.queueBuild(tenant.organizationId);
      return context.json(await presented(tenant.organizationId, tenant.role));
    });
}
