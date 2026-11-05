import { z } from "zod";

const slackTargetSchema = z.object({
  kind: z.literal("slack"), integrationAccountId: z.uuid(), channelId: z.string().regex(/^[CG][A-Z0-9]+$/u),
});
// A Claude routine started for each new or regressed error.
const claudeRoutineTargetSchema = z.object({ kind: z.literal("claude_routine"), routineId: z.uuid() });
export const errorNotificationTargetSchema = z.discriminatedUnion("kind", [slackTargetSchema, claudeRoutineTargetSchema]);
export const errorNotificationSettingsSchema = z.object({
  enabled: z.boolean(),
  // Plain error log lines stay on the Errors page and post nothing.
  exceptionsOnly: z.boolean().optional(),
  // At most one Slack channel and one Claude routine.
  targets: z.array(errorNotificationTargetSchema).max(2),
}).refine((value) => new Set(value.targets.map((target) => target.kind)).size === value.targets.length, {
  message: "Choose one Slack channel and one Claude routine at most",
}).refine((value) => !value.enabled || value.targets.length > 0, {
  message: "Choose a Slack channel or a Claude routine before enabling notifications",
});
export type ErrorNotificationTarget = z.infer<typeof errorNotificationTargetSchema>;
export type ErrorNotificationSlackTarget = z.infer<typeof slackTargetSchema>;
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
  return target.kind === "slack" ? `slack:${target.integrationAccountId}:${target.channelId}` : `claude_routine:${target.routineId}`;
}
export function errorNotificationSlackTarget(settings: ErrorNotificationSettings): ErrorNotificationSlackTarget | null {
  return settings.targets.find((target) => target.kind === "slack") ?? null;
}
export function errorNotificationRoutineId(settings: ErrorNotificationSettings): string | null {
  return settings.targets.find((target) => target.kind === "claude_routine")?.routineId ?? null;
}
// The context a Claude routine gets for a new or regressed error.
export function errorRoutineText(snapshot: ErrorNotificationSnapshot, issueId: string, url: string): string {
  return [
    snapshot.transition === "new" ? "Superlog saw a new error." : "An error Superlog had marked resolved occurred again.",
    "",
    `Error: ${snapshot.title}`,
    `Type: ${snapshot.exceptionType}`,
    `Service: ${snapshot.service ?? "unknown"}`,
    `Seen at: ${snapshot.seenAt}`,
    `Error issue ID: ${issueId}`,
    `Error issue: ${url}`,
  ].join("\n");
}
export function matchesErrorNotification(settings: ErrorNotificationSettings): boolean {
  return settings.enabled;
}
// Whether settings post an issue that is, or is not, an exception.
export function notifiesErrorIssue(settings: ErrorNotificationSettings, exception: boolean): boolean {
  return matchesErrorNotification(settings) && (exception || !settings.exceptionsOnly);
}
