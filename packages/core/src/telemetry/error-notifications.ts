import { z } from "zod";

export const errorNotificationTargetSchema = z.object({
  kind: z.literal("slack"), integrationAccountId: z.uuid(), channelId: z.string().regex(/^[CG][A-Z0-9]+$/u),
});
export const errorNotificationSettingsSchema = z.object({
  enabled: z.boolean(),
  targets: z.array(errorNotificationTargetSchema).max(1),
}).refine((value) => !value.enabled || value.targets.length === 1, {
  message: "Choose a Slack channel before enabling notifications",
});
export type ErrorNotificationTarget = z.infer<typeof errorNotificationTargetSchema>;
export type ErrorNotificationSettings = z.infer<typeof errorNotificationSettingsSchema>;
export const defaultErrorNotificationSettings: ErrorNotificationSettings = {
  enabled: false, targets: [],
};
export type ErrorNotificationSnapshot = {
  title: string;
  service: string | null;
  exceptionType: string;
  seenAt: string;
  transition: "new" | "regressed";
};
export function errorNotificationTargetKey(target: ErrorNotificationTarget): string {
  return `slack:${target.integrationAccountId}:${target.channelId}`;
}
export function matchesErrorNotification(settings: ErrorNotificationSettings): boolean {
  return settings.enabled;
}
