import { z } from "zod";
import {
  getErrorNotificationSettings,
  saveErrorNotificationSettings,
} from "../../../../packages/core/src/db/error-notifications.js";
import { findClaudeRoutine } from "../../../../packages/core/src/db/claude-routines.js";
import { organizationHasCapability } from "../../../../packages/core/src/db/organization-capabilities.js";
import { listTelemetryAlertSlackChannels } from "../../../../packages/core/src/db/telemetry-alerts.js";
import {
  errorNotificationRoutineId,
  errorNotificationSlackTarget,
  type ErrorNotificationSettings,
} from "../../../../packages/core/src/telemetry/error-notifications.js";
import { defineOperation, ManagementError, type ManagementContext } from "./operation.js";

// The Slack channel and Claude routine that hear about new and regressed
// error issues, as the Notifications dialog on the Errors page sets them.

const slackSchema = z.object({
  channelId: z.string().trim().regex(/^[CG][A-Z0-9]+$/u).describe("The Slack channel ID: the `externalId` of a `slack_channel` resource."),
  integrationAccountId: z.uuid().describe("The ID of the Slack integration the channel belongs to."),
});

const notificationsSchema = z.object({
  enabled: z.boolean(),
  exceptionsOnly: z.boolean(),
  slack: z.object({ channelId: z.string(), integrationAccountId: z.string() }).nullable(),
  claudeRoutineId: z.string().nullable(),
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
  const target = errorNotificationSlackTarget(settings);
  return {
    enabled: settings.enabled,
    exceptionsOnly: settings.exceptionsOnly ?? false,
    slack: target ? { channelId: target.channelId, integrationAccountId: target.integrationAccountId } : null,
    claudeRoutineId: errorNotificationRoutineId(settings),
  };
}

export const errorNotificationOperations = [
  defineOperation({
    name: "get_error_notifications",
    summary: "Get error notifications",
    description: "Returns whether new and regressed error issues post to Slack and start a Claude routine, and which ones. Workspace owners and admins only.",
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
      "Posts each new error issue, and each resolved issue that occurs again, to one Slack channel, and can start one Claude routine with the error's details. For a private channel, invite the Superlog app first. Earlier errors are not sent. Workspace owners and admins only.",
    method: "PATCH",
    path: "/error-notifications",
    tag: "Errors",
    effect: "write",
    input: z.object({
      enabled: z.boolean(),
      exceptionsOnly: z.boolean().optional().describe("Post only exceptions, not plain error log lines. Keeps the current value when left out."),
      slack: slackSchema.nullable().optional().describe("Keeps the current channel when left out. Turning notifications on needs a channel or a routine."),
      claudeRoutineId: z
        .uuid()
        .nullable()
        .optional()
        .describe("The `id` of one of the workspace's Claude routines, started once for each new or regressed error. Keeps the current routine when left out."),
    }),
    output: z.object({ notifications: notificationsSchema }),
    async run(context, input) {
      await requireErrorNotificationAdmin(context);
      const current = await getErrorNotificationSettings(context.organizationId);
      const slack = input.slack === undefined ? presented(current).slack : input.slack;
      const claudeRoutineId = input.claudeRoutineId === undefined ? presented(current).claudeRoutineId : input.claudeRoutineId;
      if (input.enabled && !slack && !claudeRoutineId) {
        throw new ManagementError(422, "Choose a Slack channel or a Claude routine before turning notifications on.", "slack_channel_required");
      }
      if (claudeRoutineId && (input.enabled || input.claudeRoutineId) && !(await findClaudeRoutine(context.organizationId, claudeRoutineId))) {
        throw new ManagementError(422, "Choose one of the workspace's Claude routines.", "claude_routine_unavailable");
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
        exceptionsOnly: input.exceptionsOnly ?? current.exceptionsOnly ?? false,
        targets: [
          ...(slack ? [{ kind: "slack" as const, ...slack }] : []),
          ...(claudeRoutineId ? [{ kind: "claude_routine" as const, routineId: claudeRoutineId }] : []),
        ],
      };
      await saveErrorNotificationSettings(context.organizationId, settings);
      return { notifications: presented(await getErrorNotificationSettings(context.organizationId)) };
    },
  }),
];
