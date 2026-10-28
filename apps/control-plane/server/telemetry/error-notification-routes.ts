import { Hono } from "hono";
import { getErrorNotificationSettings, saveErrorNotificationSettings } from "../../../../packages/core/src/db/error-notifications.js";
import { listTelemetryAlertSlackChannels } from "../../../../packages/core/src/db/telemetry-alerts.js";
import { organizationHasCapability } from "../../../../packages/core/src/db/organization-capabilities.js";
import { errorNotificationSettingsSchema } from "../../../../packages/core/src/telemetry/error-notifications.js";
import { refreshSlackChannelResources } from "../../../../packages/core/src/integrations/slack-channels.js";
import { getActiveTenant } from "../tenant.js";

const defaults = {
  tenant: getActiveTenant, hasCapability: organizationHasCapability,
  get: getErrorNotificationSettings, save: saveErrorNotificationSettings,
  channels: listTelemetryAlertSlackChannels,
  refresh: refreshSlackChannelResources,
};
export function createErrorNotificationRoutes(deps = defaults) {
  return new Hono<{ Variables: { organizationId: string } }>().use("*", async (context, next) => {
    const tenant = await deps.tenant(context.req.raw.headers);
    if (!tenant.ok) return context.json({ error: tenant.error }, tenant.status);
    if (!(await deps.hasCapability(tenant.organizationId, "telemetry"))) return context.json({ error: "Errors are not available" }, 404);
    // Notification routing can disclose error details; only workspace
    // administrators can read recipients or change destinations.
    if (!tenant.role.split(",").some((role) => ["owner", "admin"].includes(role.trim()))) {
      return context.json({ error: "Workspace administrator access required" }, 403);
    }
    context.set("organizationId", tenant.organizationId);
    await next();
  }).get("/", async (context) => {
    const organizationId = context.get("organizationId");
    const [settings, channels] = await Promise.all([deps.get(organizationId), deps.channels(organizationId)]);
    return context.json({ settings, channels }, 200, { "cache-control": "no-store" });
  }).post("/refresh-channels", async (context) => {
    const organizationId = context.get("organizationId");
    await deps.refresh(organizationId);
    return context.json({ channels: await deps.channels(organizationId) });
  }).put("/", async (context) => {
    const organizationId = context.get("organizationId");
    const parsed = errorNotificationSettingsSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ error: parsed.error.issues[0]?.message ?? "Invalid notification settings" }, 400);
    const channels = await deps.channels(organizationId);
    if (parsed.data.enabled && parsed.data.targets.some((target) => !channels.some((channel) => channel.integrationAccountId === target.integrationAccountId && channel.channelId === target.channelId))) {
      return context.json({ error: "Choose an available Slack channel" }, 400);
    }
    await deps.save(organizationId, parsed.data);
    return context.json({ settings: await deps.get(organizationId) });
  });
}
