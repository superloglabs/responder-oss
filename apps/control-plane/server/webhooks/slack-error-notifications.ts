import { z } from "zod";
import { getErrorNotificationForSlackAction } from "@responder/core/db/error-notifications";
import { setErrorIssueStatus } from "@responder/core/db/error-issues";
import { organizationHasCapability } from "@responder/core/db/organization-capabilities";
import { errorNotificationActionStatuses } from "@responder/core/telemetry/error-notification-actions";

const defaults = { find: getErrorNotificationForSlackAction, setStatus: setErrorIssueStatus, hasCapability: organizationHasCapability };
const ephemeral = (text: string) => ({ response_type: "ephemeral", replace_original: false, text });

// Called only after the webhook has verified Slack's signature and response URL.
// Anyone in the destination channel may triage the issue shared there. The
// change is recorded as theirs, and the worker then updates the notification
// and replies in its thread.
export async function pressErrorNotificationButton(input: {
  actionId: string; deliveryId?: string; teamId: string; channelId: string; user: { id: string; name?: string };
}, deps = defaults): Promise<Record<string, unknown>> {
  const actionId = z.enum(["error_notification_resolve", "error_notification_silence"]).safeParse(input.actionId);
  if (!actionId.success) return ephemeral("This error action is unavailable.");
  const status = errorNotificationActionStatuses[actionId.data];
  const deliveryId = z.uuid().safeParse(input.deliveryId);
  if (!status || !deliveryId.success) return ephemeral("This error action is unavailable.");
  const delivery = await deps.find({ deliveryId: deliveryId.data, teamId: input.teamId, channelId: input.channelId });
  if (!delivery || !(await deps.hasCapability(delivery.organizationId, "telemetry"))) {
    return ephemeral("This error is no longer available through this Slack connection.");
  }
  const issue = await deps.setStatus(delivery.organizationId, delivery.issueId, status, {
    actor: { agent: null, client: "Slack", slackUserId: input.user.id, user: { id: input.user.id, name: input.user.name ?? "A Slack user" } },
  });
  if (!issue) return ephemeral("This error no longer exists.");
  return ephemeral(status === "resolved"
    ? "Error resolved. It will reopen if it occurs again."
    : "Error silenced. Future occurrences will still be counted without reopening it. You can reopen it from the error page.");
}
