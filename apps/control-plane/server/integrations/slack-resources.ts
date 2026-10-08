import { refreshSlackChannelResources as refreshChannels } from "../../../../packages/core/src/integrations/slack-channels.js";
import { listSlackChannels } from "./slack.js";

export function refreshSlackChannelResources(organizationId: string): Promise<void> {
  return refreshChannels(organizationId, listSlackChannels);
}
