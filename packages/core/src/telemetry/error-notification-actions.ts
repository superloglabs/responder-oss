import { conductorButton } from "../ide-handoff.js";

export const errorNotificationActionStatuses = {
  error_notification_resolve: "resolved",
  error_notification_silence: "silenced",
} as const;

export function errorNotificationActions(input: { deliveryId: string; url: string; context: string }) {
  return {
    type: "actions",
    block_id: "error_notification_actions",
    elements: [
      { type: "button", action_id: "error_notification_resolve", text: { type: "plain_text", text: "Resolve" }, value: input.deliveryId },
      { type: "button", action_id: "error_notification_silence", text: { type: "plain_text", text: "Silence" }, value: input.deliveryId },
      conductorButton({ kind: "fix", sourceUrl: input.url, context: input.context }),
    ],
  };
}
