import {
  abandonPendingAutomationRun,
  beginAutomationRun,
  findAutomationsForSlackEvent,
  getSlackAppIdentity,
} from "@responder/core/db/automations";

export interface AlertAutomationDependencies {
  abandon: typeof abandonPendingAutomationRun;
  begin: typeof beginAutomationRun;
  find: typeof findAutomationsForSlackEvent;
  identity: typeof getSlackAppIdentity;
  queue: (run: { organizationId: string; runId: string }) => Promise<void>;
}

export const defaultAlertAutomationDependencies: Omit<AlertAutomationDependencies, "queue"> = {
  abandon: abandonPendingAutomationRun,
  begin: beginAutomationRun,
  find: findAutomationsForSlackEvent,
  identity: getSlackAppIdentity,
};

// Slack does not deliver the app's own messages as events that start
// automations, so an alert, or a failing synthetic check, starts the
// automations watching its channel itself, as if the message had arrived
// from Slack. Each automation runs once per episode, and its replies go in
// the message's thread.
export async function startAlertAutomations(
  input: {
    body: string;
    channelId: string;
    episodeId: string;
    // What opened the episode. Each automation runs once per episode.
    episodeSource?: "synthetic-check-episode" | "telemetry-alert-episode";
    integrationAccountId: string;
    organizationId: string;
    timestamp: string;
    title: string;
  },
  dependencies: AlertAutomationDependencies,
): Promise<number> {
  const identity = await dependencies.identity({
    integrationAccountId: input.integrationAccountId,
    organizationId: input.organizationId,
  });
  if (!identity) return 0;
  const authorIds = [identity.appId, identity.botUserId].filter((id): id is string => Boolean(id));
  const matches = await dependencies.find({
    authorIds,
    channelId: input.channelId,
    eventType: "message",
    ownMessage: true,
    teamId: identity.teamId,
    text: input.body,
    timestamp: input.timestamp,
  });
  let started = 0;
  for (const match of matches) {
    // The lookup covers every workspace connected to this Slack team.
    if (
      !match.startsRun ||
      match.organizationId !== input.organizationId ||
      match.integrationAccountId !== input.integrationAccountId
    ) {
      continue;
    }
    try {
      const run = await dependencies.begin({
        automationId: match.automationId,
        trigger: {
          attributes: {
            ...(authorIds[0] ? { authorId: authorIds[0], authorName: "Superlog", authorType: "app" } : {}),
            channelId: input.channelId,
            mentioned: false,
            teamId: identity.teamId,
            threadTimestamp: input.timestamp,
            timestamp: input.timestamp,
          },
          body: input.body,
          externalEventId: `${input.episodeSource ?? "telemetry-alert-episode"}:${input.episodeId}:${match.automationId}`,
          provider: "slack",
          sourceUrl: `https://slack.com/archives/${input.channelId}/p${input.timestamp.replace(".", "")}`,
          title: input.title,
        },
      });
      if (!run.created) continue;
      try {
        await dependencies.queue({ organizationId: run.organizationId, runId: run.runId });
      } catch (error) {
        // Without a job the run would wait as pending forever.
        await dependencies.abandon(run.runId);
        throw error;
      }
      started += 1;
    } catch (error) {
      console.warn(JSON.stringify({
        automationId: match.automationId,
        error: error instanceof Error ? error.message : String(error),
        event: "telemetry_alert_automation_failed",
      }));
    }
  }
  return started;
}
