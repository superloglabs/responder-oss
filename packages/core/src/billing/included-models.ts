import type { AutomationModelProvider } from "../automations/config.js";
import { listAIGatewayModels, type AIGatewayModel } from "../automations/model-pricing.js";
import { organizationRunBilling } from "./autumn.js";

// The models a workspace's automations can use on included usage. A
// workspace that pays per run uses only its plan's model, which no provider
// lists.
export async function listIncludedModels(
  organizationId: string,
  provider: AutomationModelProvider,
): Promise<AIGatewayModel[]> {
  return await organizationRunBilling(organizationId) ? [] : listAIGatewayModels(provider);
}
