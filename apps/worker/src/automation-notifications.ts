import { createHash } from "node:crypto";
import type { AutomationNotification } from "@responder/core/automations/config";
import { decryptCredentials } from "@responder/core/credentials/encryption";
import { getAutomationNotificationAccount } from "@responder/core/db/automations";
import { postSlackMessage } from "@responder/core/integrations/slack";
import { responderAutomationRunUrl } from "@responder/core/responder-urls";
import { z } from "zod";

// Slack's markdown block holds at most 12,000 characters.
const maxMarkdownLength = 11_500;

export type AutomationRunOutcome =
  | { status: "failed"; message: string }
  | { status: "succeeded"; message: string | null };

export interface AutomationNotificationDependencies {
  getAccount: typeof getAutomationNotificationAccount;
  post: typeof postSlackMessage;
}

const defaultDependencies: AutomationNotificationDependencies = {
  getAccount: getAutomationNotificationAccount,
  post: postSlackMessage,
};

// Slack deduplicates a retried post by this ID, which must be a UUID.
function notificationMessageId(seed: string, channelId: string): string {
  const hex = createHash("sha256").update(`${seed}\0${channelId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function automationNotificationMessage(input: {
  automationName: string;
  outcome: AutomationRunOutcome;
  runUrl: string | null;
}): { markdown: string; text: string } {
  const name = input.automationName.trim() || "Automation";
  const link = input.runUrl ? `\n\n[View run](${input.runUrl})` : "";
  if (input.outcome.status === "failed") {
    return {
      markdown: `**${name}** failed: ${input.outcome.message}${link}`,
      text: `${name} failed`,
    };
  }
  let response = input.outcome.message?.trim() ?? "";
  const room = maxMarkdownLength - name.length - link.length - 20;
  if (response.length > room) {
    response = `${response.slice(0, room).trimEnd()}\n\n…`;
  }
  return {
    markdown: `**${name}** finished.${response ? `\n\n${response}` : ""}${link}`,
    text: `${name} finished`,
  };
}

export function automationRunUrl(input: {
  automationId: string;
  environment: NodeJS.ProcessEnv;
  organizationId: string;
  runId: string;
}): string | null {
  const origin = input.environment.RESPONDER_APP_URL ?? input.environment.BETTER_AUTH_URL;
  return origin
    ? responderAutomationRunUrl({
        automationId: input.automationId,
        organizationId: input.organizationId,
        origin,
        runId: input.runId,
      })
    : null;
}

export type AutomationNotificationDelivery =
  | { error: unknown; notification: AutomationNotification }
  | { notification: AutomationNotification; timestamp: string | null };

// Posts one message to each channel. A failed channel does not stop the
// others. The seed makes a retry of the same message a duplicate to Slack.
export async function postAutomationNotification(input: {
  // Buttons that continue the run, under the message.
  buttonsBlock?: unknown;
  markdown: string;
  notifications: AutomationNotification[];
  organizationId: string;
  seed: string;
  text: string;
  // Posts a reply in this thread instead of a new message.
  threadTimestamp?: string;
}, dependencies: AutomationNotificationDependencies = defaultDependencies): Promise<AutomationNotificationDelivery[]> {
  const deliveries: AutomationNotificationDelivery[] = [];
  for (const notification of input.notifications) {
    try {
      const account = await dependencies.getAccount({
        integrationAccountId: notification.integrationAccountId,
        organizationId: input.organizationId,
      });
      if (!account) throw new Error("The Slack connection is unavailable");
      const { accessToken } = z.object({ accessToken: z.string().min(1) }).parse(
        decryptCredentials<Record<string, unknown>>(account.encryptedCredentials),
      );
      const timestamp = await dependencies.post({
        accessToken,
        blocks: [
          { type: "markdown", text: input.markdown },
          ...(input.buttonsBlock ? [input.buttonsBlock] : []),
        ],
        channelId: notification.channelId,
        clientMessageId: notificationMessageId(input.seed, notification.channelId),
        text: input.text,
        ...(input.threadTimestamp ? { threadTimestamp: input.threadTimestamp } : {}),
      });
      deliveries.push({ notification, timestamp });
    } catch (error) {
      deliveries.push({ error, notification });
    }
  }
  return deliveries;
}

// A message the agent posts itself. The top-level message links back to the
// run; thread replies pass no link.
export function agentNotificationMessage(text: string, runUrl: string | null): { markdown: string; text: string } {
  const link = runUrl ? `\n\n[View run](${runUrl})` : "";
  let body = text.trim();
  const room = maxMarkdownLength - link.length;
  if (body.length > room) body = `${body.slice(0, room - 3).trimEnd()}\n\n…`;
  const firstLine = body.split("\n").map((line) => line.replace(/^[#>*\-\s]+/u, "").trim()).find(Boolean);
  return { markdown: `${body}${link}`, text: (firstLine ?? "Automation update").slice(0, 200) };
}

// Reports a finished run to each notification channel when the agent did not
// post itself, or when the run failed.
export async function sendAutomationRunNotifications(input: {
  automationId: string;
  automationName: string;
  environment: NodeJS.ProcessEnv;
  notifications: AutomationNotification[];
  onError(notification: AutomationNotification, error: unknown): Promise<void>;
  organizationId: string;
  outcome: AutomationRunOutcome;
  runId: string;
  // Reports a turn that answered a button in the pressed message's thread.
  // The pressed message's event tells Slack which turn's report a retry is.
  thread?: { eventId: number; timestamp: string };
}, dependencies: AutomationNotificationDependencies = defaultDependencies): Promise<void> {
  const message = automationNotificationMessage({
    automationName: input.automationName,
    outcome: input.outcome,
    runUrl: automationRunUrl(input),
  });
  const deliveries = await postAutomationNotification({
    ...message,
    notifications: input.notifications,
    organizationId: input.organizationId,
    seed: input.thread ? `${input.runId}:${input.thread.eventId}` : input.runId,
    ...(input.thread ? { threadTimestamp: input.thread.timestamp } : {}),
  }, dependencies);
  for (const delivery of deliveries) {
    if ("error" in delivery) await input.onError(delivery.notification, delivery.error);
  }
}
