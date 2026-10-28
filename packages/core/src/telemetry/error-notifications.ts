import { z } from "zod";

export const errorNotificationTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("slack"), integrationAccountId: z.uuid(), channelId: z.string().regex(/^[CG][A-Z0-9]+$/u) }),
  z.object({ kind: z.literal("email"), userId: z.uuid() }),
]);
export const errorNotificationSettingsSchema = z.object({
  enabled: z.boolean(),
  newErrors: z.boolean(),
  regressions: z.boolean(),
  services: z.array(z.string().trim().min(1).max(200)).max(100),
  targets: z.array(errorNotificationTargetSchema).max(20),
}).refine((value) => !value.enabled || (value.targets.length > 0 && (value.newErrors || value.regressions)), {
  message: "Choose a destination and at least one error event before enabling notifications",
});
export type ErrorNotificationTarget = z.infer<typeof errorNotificationTargetSchema>;
export type ErrorNotificationSettings = z.infer<typeof errorNotificationSettingsSchema>;
export const defaultErrorNotificationSettings: ErrorNotificationSettings = {
  enabled: false, newErrors: true, regressions: true, services: [], targets: [],
};
export type ErrorNotificationSnapshot = {
  title: string;
  service: string | null;
  exceptionType: string;
  seenAt: string;
  transition: "new" | "regressed";
};
export function errorNotificationTargetKey(target: ErrorNotificationTarget): string {
  return target.kind === "email" ? `email:${target.userId}` : `slack:${target.integrationAccountId}:${target.channelId}`;
}
export function matchesErrorNotification(settings: ErrorNotificationSettings, event: ErrorNotificationSnapshot): boolean {
  return settings.enabled && (event.transition === "new" ? settings.newErrors : settings.regressions)
    && (settings.services.length === 0 || (event.service !== null && settings.services.includes(event.service)));
}
