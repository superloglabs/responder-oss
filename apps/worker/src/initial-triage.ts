import {
  createGateway,
  experimental_evaluate as evaluate,
  type JSONValue,
} from "ai";
import { z } from "zod";
import { decryptCredentials } from "@responder/core/credentials/encryption";
import { getSlackInvestigationLiveContext } from "@responder/core/db/issues";
import {
  getInitialTriageContext,
  getRuntimeSentryConnection,
  setInvestigationSlackReaction,
} from "@responder/core/db/investigations";
import {
  addSlackReaction,
  INITIAL_TRIAGE_SLACK_REACTIONS,
  removeSlackReaction,
} from "@responder/core/integrations/slack";
import { fetchSentryIssueTriageContext } from "./sentry-issue-context.js";

const slackCredentialsSchema = z.object({
  accessToken: z.string().min(1),
});

export const INITIAL_TRIAGE_REACTIONS = INITIAL_TRIAGE_SLACK_REACTIONS;

const initialTriageQuestions = {
  priority: {
    type: "choice" as const,
    instructions:
      "Choose one initial Slack severity reaction for the current alert. Use recent incidents only as context for recurrence and known impact, not as proof that the current alert has the same cause. Reserve red_circle for clear SEV-1 evidence. Choose large_green_circle only when the evidence indicates there is no issue requiring triage. Choose unclear when the evidence does not support a severity or a no-issue conclusion.",
    criteria: {
      red_circle:
        "SEV-1: a critical active incident such as a broad outage, core service unavailable, security breach, data loss, or severe widespread customer impact requiring immediate response.",
      large_orange_circle:
        "SEV-2: a significant active incident causing major degradation or meaningful customer impact that needs an urgent response but is not a SEV-1.",
      large_yellow_circle:
        "SEV-3: a credible but limited, minor, or localized issue that should be investigated through the normal response process.",
      large_green_circle:
        "No issue: the alert is informational, a false positive, expected behavior, resolved already, or otherwise requires no incident response.",
      unclear:
        "No reaction: there is not enough reliable evidence to classify the alert as SEV-1, SEV-2, SEV-3, or no issue.",
    },
  },
};

export async function runInitialTriage(
  investigationId: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<(typeof INITIAL_TRIAGE_REACTIONS)[number] | null> {
  const context = await getInitialTriageContext(investigationId);
  if (!context) return null;

  const existing = INITIAL_TRIAGE_REACTIONS.find((reaction) =>
    context.existingReactions.includes(reaction),
  );
  if (existing) return existing;

  const apiKey = environment.AI_GATEWAY_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "AI_GATEWAY_API_KEY is required when initial Jev triage is enabled",
    );
  }

  const slack = await getSlackInvestigationLiveContext(investigationId);
  const reactionTimestamp = slack?.source.reactionTimestamp;
  if (!slack || !reactionTimestamp) return null;
  const credentials = slackCredentialsSchema.parse(
    decryptCredentials<Record<string, unknown>>(
      slack.source.encryptedCredentials,
    ),
  );
  let sentryIssue;
  if (context.alert.attributes?.slackAlertProvider === "sentry") {
    const connection = await getRuntimeSentryConnection(
      context.agentConfigVersionId,
    );
    if (!connection) {
      throw new Error(
        "A connected Sentry account is required to triage a Sentry alert",
      );
    }
    sentryIssue = await fetchSentryIssueTriageContext({
      alertBody: context.alert.body,
      connection,
    });
  }
  const gateway = createGateway({ apiKey });
  const state = JSON.parse(JSON.stringify({
    alert: context.alert,
    recentIncidents: context.recentIncidents,
    ...(sentryIssue ? { sentryIssue } : {}),
  })) as Record<string, JSONValue>;
  const result = await evaluate({
    abortSignal: AbortSignal.timeout(5_000),
    maxRetries: 1,
    model: gateway.evaluationModel("typesafe-ai/jev"),
    questions: initialTriageQuestions,
    state,
  });
  const reaction = result.answers.priority.choice;

  if (reaction === "unclear") {
    await Promise.all(
      INITIAL_TRIAGE_REACTIONS.map(async (name) => {
        await removeSlackReaction({
          accessToken: credentials.accessToken,
          channelId: slack.source.channelId,
          name,
          timestamp: reactionTimestamp,
        });
        await setInvestigationSlackReaction(investigationId, name, false);
      }),
    );
    return null;
  }

  await addSlackReaction({
    accessToken: credentials.accessToken,
    channelId: slack.source.channelId,
    name: reaction,
    timestamp: reactionTimestamp,
  });
  await setInvestigationSlackReaction(investigationId, reaction, true);
  return reaction;
}
