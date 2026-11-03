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
    mocks.listAIGatewayModels.mockResolvedValue([{ id: "claude-opus-5.5", name: "Claude Opus 5.5" }]);

    await expect(listIncludedModels("organization-1", "anthropic")).resolves.toEqual([
      { id: "claude-opus-5.5", name: "Claude Opus 5.5" },
    ]);
  });

  it("lists only the per-run model for a workspace that pays per run", async () => {
    mocks.organizationRunBilling.mockResolvedValue({
      customerId: "earlier-customer",
      featureId: "investigations",
      model: "claude-sonnet-5.5",
      modelName: "Per-run model",
      modelProvider: "anthropic",
    });

    await expect(listIncludedModels("organization-1", "anthropic")).resolves.toEqual([
      { id: "claude-sonnet-5.5", name: "Per-run model" },
    ]);
    await expect(listIncludedModels("organization-1", "openai")).resolves.toEqual([]);
    expect(mocks.listAIGatewayModels).not.toHaveBeenCalled();
  });
});
