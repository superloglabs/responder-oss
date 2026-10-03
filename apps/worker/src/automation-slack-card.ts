import { z } from "zod";
import type { AutomationTranscriptItem } from "@responder/core/automations/transcript";
import { decryptCredentials } from "@responder/core/credentials/encryption";
import {
  postSlackMessage,
  updateSlackMessage,
} from "@responder/core/integrations/slack";
import { slackAutomationRunCard } from "@responder/core/integrations/slack-live-card";

export const automationSlackCardUpdateIntervalMs = 3_000;

export interface AutomationSlackCardTarget {
  accessToken: string;
  channelId: string;
  // Whether the message that started the run mentions the app.
  mentioned: boolean;
  threadTimestamp: string;
}

export interface AutomationSlackCardDependencies {
  now(): number;
  post: typeof postSlackMessage;
  update: typeof updateSlackMessage;
}

export const defaultAutomationSlackCardDependencies: AutomationSlackCardDependencies = {
  now: () => Date.now(),
  post: postSlackMessage,
  update: updateSlackMessage,
};

const slackTriggerSchema = z.object({
  attributes: z.object({
    channelId: z.string().min(1),
    mentioned: z.boolean().optional(),
    teamId: z.string().min(1),
    threadTimestamp: z.string().min(1).optional(),
    timestamp: z.string().min(1),
  }),
  provider: z.literal("slack"),
});

// The thread of the Slack message that started the run, reached through the
// automation's connection to that workspace. The context broker picks the
// same connection for the agent's Slack tools.
export function automationSlackCardTarget(
  triggerInput: Record<string, unknown>,
  connections: Array<{
    encryptedCredentials: string | null;
    externalAccountId: string | null;
    provider: string;
  }>,
): AutomationSlackCardTarget | null {
  const trigger = slackTriggerSchema.safeParse(triggerInput);
  if (!trigger.success) return null;
  const { channelId, mentioned, teamId, threadTimestamp, timestamp } = trigger.data.attributes;
  const connection = connections.find((candidate) =>
    candidate.provider === "slack" &&
    candidate.externalAccountId === teamId &&
    candidate.encryptedCredentials
  );
  if (!connection?.encryptedCredentials) return null;
  const credentials = z.object({ accessToken: z.string().min(1) }).safeParse(
    decryptCredentials<Record<string, unknown>>(connection.encryptedCredentials),
  );
  if (!credentials.success) return null;
  return {
    accessToken: credentials.data.accessToken,
    channelId,
    mentioned: mentioned === true,
    threadTimestamp: threadTimestamp ?? timestamp,
  };
}

export type AutomationSlackCard = ReturnType<typeof createAutomationSlackCard>;

// Posts the run's live card when the run starts, keeps it current as the
// transcript grows, and marks it finished. With `agentPosted`, the card waits
// until the agent has posted in the thread, so a run that decides to stay
// quiet leaves nothing there. The card is best effort: Slack failures go to
// onError and never stop the run.
export function createAutomationSlackCard(input: {
  agentPosted?: () => Promise<boolean>;
  automationId: string;
  dependencies?: AutomationSlackCardDependencies;
  onError(error: unknown): void;
  organizationId: string;
  runId: string;
  target: AutomationSlackCardTarget;
}) {
  const dependencies = input.dependencies ?? defaultAutomationSlackCardDependencies;
  let items: AutomationTranscriptItem[] = [];
  let timestamp: string | null = null;
  let finished = false;
  let waiting = Boolean(input.agentPosted);
  // When the card last changed, or while waiting, when the agent's posts
  // were last checked.
  let lastSentAt = Number.NEGATIVE_INFINITY;
  let trailing: ReturnType<typeof setTimeout> | undefined;
  // Updates run in order so an older card never replaces a newer one.
  let writes = Promise.resolve();

  const card = (
    status: "complete" | "error" | "in_progress",
    detail?: string,
  ) => slackAutomationRunCard({
    automationId: input.automationId,
    detail,
    items,
    organizationId: input.organizationId,
    runId: input.runId,
    status,
  });

  async function post(status: "complete" | "error" | "in_progress", detail?: string): Promise<void> {
    const message = card(status, detail);
    try {
      timestamp = await dependencies.post({
        accessToken: input.target.accessToken,
        blocks: message.blocks,
        channelId: input.target.channelId,
        text: message.text,
        threadTimestamp: input.target.threadTimestamp,
      });
      lastSentAt = dependencies.now();
    } catch (error) {
      input.onError(error);
    }
  }

  function send(status: "complete" | "error" | "in_progress", detail?: string) {
    lastSentAt = dependencies.now();
    writes = writes.then(async () => {
      if (waiting) {
        if (!(await input.agentPosted!())) return;
        // A failed post leaves the card waiting, so the next send tries again.
        await post(status, detail);
        if (timestamp) waiting = false;
        return;
      }
      if (!timestamp) return;
      const message = card(status, detail);
      await dependencies.update({
        accessToken: input.target.accessToken,
        blocks: message.blocks,
        channelId: input.target.channelId,
        text: message.text,
        timestamp,
      });
    }).catch(input.onError);
    return writes;
  }

  return {
    async start(): Promise<void> {
      if (!waiting) await post("in_progress");
    },
    progress(next: AutomationTranscriptItem[]): void {
      if (finished || (!waiting && !timestamp) || next.length === items.length) return;
      items = next;
      if (trailing) return;
      const wait = lastSentAt + automationSlackCardUpdateIntervalMs - dependencies.now();
      if (wait <= 0) {
        void send("in_progress");
        return;
      }
      trailing = setTimeout(() => {
        trailing = undefined;
        if (!finished) void send("in_progress");
      }, wait);
    },
    async finish(
      status: "complete" | "error",
      detail?: string,
      finalItems?: AutomationTranscriptItem[],
    ): Promise<void> {
      if (finished) return;
      finished = true;
      clearTimeout(trailing);
      if (finalItems) items = finalItems;
      await send(status, detail);
    },
  };
}
