import { describe, expect, it } from "vitest";
import { automationRunDisplayStatus, automationRunStatusLabels } from "./automation-run-status";

describe("automationRunDisplayStatus", () => {
  it("shows a run the usage allowance stopped as a usage limit", () => {
    const status = automationRunDisplayStatus({ failureCategory: "usage_limit_reached", status: "failed" });

    expect(status).toBe("usage_limit");
    expect(automationRunStatusLabels[status]).toBe("Usage limit");
  });

  it("keeps other failures as failed", () => {
    expect(automationRunDisplayStatus({ failureCategory: "execution_failed", status: "failed" })).toBe("failed");
    expect(automationRunDisplayStatus({ failureCategory: null, status: "succeeded" })).toBe("succeeded");
  });
});
