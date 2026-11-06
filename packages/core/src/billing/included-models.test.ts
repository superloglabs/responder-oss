import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listAIGatewayModels: vi.fn(),
  organizationRunBilling: vi.fn(),
}));

vi.mock("../automations/model-pricing.js", () => ({ listAIGatewayModels: mocks.listAIGatewayModels }));
vi.mock("./autumn.js", () => ({ organizationRunBilling: mocks.organizationRunBilling }));

const { listIncludedModels } = await import("./included-models.js");

describe("included models", () => {
  afterEach(() => vi.resetAllMocks());

  it("lists the gateway's models for a workspace on a usage plan", async () => {
    mocks.organizationRunBilling.mockResolvedValue(null);
    mocks.listAIGatewayModels.mockResolvedValue([{ id: "model-b", name: "Model B" }]);

    await expect(listIncludedModels("organization-1", "anthropic")).resolves.toEqual([
      { id: "model-b", name: "Model B" },
    ]);
  });

  it("lists no provider's models for a workspace that pays per run", async () => {
    mocks.organizationRunBilling.mockResolvedValue({
      customerId: "earlier-customer",
      featureId: "investigations",
      harness: "claude_agent_sdk",
      model: "model-a",
      modelName: "Plan model",
      modelProvider: "anthropic",
    });

    await expect(listIncludedModels("organization-1", "anthropic")).resolves.toEqual([]);
    await expect(listIncludedModels("organization-1", "openai")).resolves.toEqual([]);
    expect(mocks.listAIGatewayModels).not.toHaveBeenCalled();
  });
});
