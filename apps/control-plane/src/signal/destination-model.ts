import type { SignalDeliveryProblem, SignalSettings } from "./model";

export type FindingsDestination = "slack" | "discord";

// The destination a workspace starts setup with: the one it already has.
export function initialDestination(settings: Pick<SignalSettings, "slack" | "discord">): FindingsDestination | null {
  if (settings.slack) return "slack";
  if (settings.discord.connected) return "discord";
  return null;
}

// Whether setup can continue with the chosen destination, and if not, why.
export function destinationBlocker(
  choice: FindingsDestination | null,
  settings: Pick<SignalSettings, "slack" | "discord">,
  slackConnected: boolean,
): string | null {
  if (choice === "slack") {
    if (!slackConnected) return "Connect Slack to continue.";
    return settings.slack ? null : "Choose a findings channel to continue.";
  }
  if (choice === "discord") return settings.discord.connected ? null : "Connect Discord to continue.";
  return "Choose Slack or Discord to continue.";
}

// What Slack's sign-in sent back, in words.
export function slackSignInProblem(reason: string | null) {
  const cause = reason === "access_denied" ? ": the approval was cancelled" : reason ? ` (${reason})` : "";
  return `Slack did not connect${cause}. Try again, or ask a Slack admin to approve the app.`;
}

export const discordInstructions = "In Discord, open the channel's settings › Integrations › Webhooks › New Webhook, then Copy Webhook URL.";

// Why Discord stopped taking posts, with the findings waiting to go out.
export function discordProblemText(delivery: SignalDeliveryProblem, now = new Date()) {
  const since = new Date(delivery.since);
  const when = `${since.toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${since.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
  const hours = delivery.firstExpiresAt
    ? Math.max(1, Math.round((new Date(delivery.firstExpiresAt).getTime() - now.getTime()) / 3_600_000))
    : null;
  const waiting = delivery.waiting > 0 && hours !== null
    ? ` ${delivery.waiting === 1 ? "1 finding is" : `${delivery.waiting} findings are`} waiting; the first expires in ${hours} h.`
    : "";
  return `Discord stopped accepting posts on ${when}. The webhook was deleted or changed.${waiting}`;
}

