import type { AutomationModelProvider } from "../automations/config.js";
import { listAIGatewayModels, type AIGatewayModel } from "../automations/model-pricing.js";
import { organizationRunBilling } from "./autumn.js";

// The models a workspace's automations can use on included usage. A
// workspace that pays per run can use only the model its price covers.
export async function listIncludedModels(
  organizationId: string,
  provider: AutomationModelProvider,
): Promise<AIGatewayModel[]> {
  const account = await organizationRunBilling(organizationId);
  if (!account) return listAIGatewayModels(provider);
  return account.modelProvider === provider ? [{ id: account.model, name: account.modelName }] : [];
}
