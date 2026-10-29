import { z } from "zod";
import {
  getErrorNotificationSettings,
  saveErrorNotificationSettings,
} from "../../../../packages/core/src/db/error-notifications.js";
import { organizationHasCapability } from "../../../../packages/core/src/db/organization-capabilities.js";
import { listTelemetryAlertSlackChannels } from "../../../../packages/core/src/db/telemetry-alerts.js";
import type { ErrorNotificationSettings } from "../../../../packages/core/src/telemetry/error-notifications.js";
import { defineOperation, ManagementError, type ManagementContext } from "./operation.js";

// The Slack channel that hears about new and regressed error issues, as the
// Notifications dialog on the Errors page sets it.

const slackSchema = z.object({
  channelId: z.string().trim().regex(/^[CG][A-Z0-9]+$/u).describe("The Slack channel ID: the `externalId` of a `slack_channel` resource."),
  integrationAccountId: z.uuid().describe("The ID of the Slack integration the channel belongs to."),
});

const notificationsSchema = z.object({
  enabled: z.boolean(),
  slack: z.object({ channelId: z.string(), integrationAccountId: z.string() }).nullable(),
});

// Notification routing can disclose error details, so only workspace owners
// and admins can read or change it.
async function requireErrorNotificationAdmin(context: ManagementContext): Promise<void> {
  if (!(await organizationHasCapability(context.organizationId, "telemetry"))) {
    throw new ManagementError(404, "Telemetry is not available in this workspace.", "telemetry_unavailable");
  }
  if (!context.role.split(",").some((role) => ["owner", "admin"].includes(role.trim()))) {
    throw new ManagementError(403, "Only workspace owners and admins can manage error notifications.", "admin_required");
  }
}

function presented(settings: ErrorNotificationSettings) {
  const target = settings.targets[0];
  return {
    enabled: settings.enabled,
    slack: target ? { channelId: target.channelId, integrationAccountId: target.integrationAccountId } : null,
  };
}

export const errorNotificationOperations = [
  defineOperation({
    name: "get_error_notifications",
    summary: "Get error notifications",
    description: "Returns whether new and regressed error issues post to Slack, and to which channel. Workspace owners and admins only.",
    method: "GET",
    path: "/error-notifications",
    tag: "Errors",
    effect: "read",
    input: z.object({}),
    output: z.object({ notifications: notificationsSchema }),
    async run(context) {
      await requireErrorNotificationAdmin(context);
      return { notifications: presented(await getErrorNotificationSettings(context.organizationId)) };
    },
  }),
  defineOperation({
    name: "update_error_notifications",
    summary: "Turn error notifications on or off",
    description:
      "Posts each new error issue, and each resolved issue that occurs again, to one Slack channel. For a private channel, invite the Superlog app first. Earlier errors are not posted. Workspace owners and admins only.",
    method: "PATCH",
    path: "/error-notifications",
    tag: "Errors",
    effect: "write",
    input: z.object({
      enabled: z.boolean(),
      slack: slackSchema.nullable().optional().describe("Required to turn notifications on. Keeps the current channel when left out."),
    }),
    output: z.object({ notifications: notificationsSchema }),
    async run(context, input) {
      await requireErrorNotificationAdmin(context);
      const current = await getErrorNotificationSettings(context.organizationId);
      const slack = input.slack === undefined ? presented(current).slack : input.slack;
      if (input.enabled && !slack) {
        throw new ManagementError(422, "Choose a Slack channel before turning notifications on.", "slack_channel_required");
      }
      // Turning notifications off keeps the saved channel even if Superlog can
      // no longer post to it. Only a channel being turned on or newly chosen
      // has to be available.
      if (slack && (input.enabled || input.slack)) {
        const channels = await listTelemetryAlertSlackChannels(context.organizationId);
        if (!channels.some((channel) => channel.channelId === slack.channelId && channel.integrationAccountId === slack.integrationAccountId)) {
          throw new ManagementError(
            422,
            "Choose a Slack channel from a connected workspace. For a private channel, invite the Superlog app first.",
            "slack_channel_unavailable",
          );
        }
      }
      const settings: ErrorNotificationSettings = {
        enabled: input.enabled,
        targets: slack ? [{ kind: "slack", ...slack }] : [],
      };
      await saveErrorNotificationSettings(context.organizationId, settings);
      return { notifications: presented(await getErrorNotificationSettings(context.organizationId)) };
    },
  }),
];
