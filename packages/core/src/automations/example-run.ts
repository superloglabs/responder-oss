// An example run replays a past Slack message or Sentry issue so a member can
// see what the automation does with it. It receives the same trigger as a
// live run, marked with `example`, and its Slack posts and reactions are shown
// on the run page instead of sent.
export function isExampleAutomationRun(trigger: Record<string, unknown>): boolean {
  const attributes = trigger.attributes;
  return typeof attributes === "object" && attributes !== null &&
    (attributes as Record<string, unknown>).example === true;
}

// Recorded when an example run would have posted to Slack.
export const slackMessagePreviewedEvent = "slack_message_previewed";
// Recorded when an example run would have added or removed a reaction.
export const slackReactionPreviewedEvent = "slack_reaction_previewed";
