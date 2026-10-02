// In organizations with simplified navigation, tag mode works as a general
// Slack assistant instead of an investigator. The control plane marks those
// requests when it queues them, so every later step can tell them apart.
export const slackAssistantAttribute = "slackAssistant";

export function isSlackAssistantRequest(input: {
  attributes?: Record<string, unknown> | null;
}): boolean {
  return input.attributes?.[slackAssistantAttribute] === true;
}
