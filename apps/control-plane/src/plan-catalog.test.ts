import { describe, expect, it } from "vitest";
import { AUTOMATION_PAID_PLANS } from "@responder/core/billing/autumn";
import { planCatalog } from "./plan-catalog";
import { FREE_PLAN_CHOICE } from "./plan-comparison";

// Hosted composition replaces the catalog, so these checks also cover the
// edition's plans.
describe("planCatalog", () => {
  it("lists each plan once", () => {
    const ids = planCatalog.plans.map((plan) => plan.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("sells only plans that billing can change to", () => {
    const sellable = new Set<string>([FREE_PLAN_CHOICE, ...AUTOMATION_PAID_PLANS.map((plan) => plan.id)]);
    for (const plan of planCatalog.plans) {
      if (plan.billingPlanId === null) expect(plan.contactUrl).toMatch(/^(?:https:\/\/|mailto:)/u);
      else expect(sellable).toContain(plan.billingPlanId);
    }
  });

  it("gives every comparison row one value per plan", () => {
    for (const group of planCatalog.comparison) {
      for (const row of group.rows) {
        expect(row.values, `${group.title}: ${row.label}`).toHaveLength(planCatalog.plans.length);
      }
    }
  });
});
