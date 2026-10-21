import { describe, expect, it } from "vitest";
import {
  canUpgrade,
  planAdditions,
  planChoice,
  planChoiceNote,
  recommendedPlanId,
  upgradePlans,
  type CatalogPlan,
  type PlanBillingState,
  type PlanCatalog,
} from "./plan-comparison";

function plan(id: string, billingPlanId: string | null, overrides: Partial<CatalogPlan> = {}): CatalogPlan {
  return {
    action: `Get ${id}`,
    audience: "",
    badge: "",
    billingPlanId,
    description: "",
    id,
    label: "",
    name: id[0]!.toUpperCase() + id.slice(1),
    price: "",
    unit: "",
    ...overrides,
  };
}

const catalog: PlanCatalog = {
  comparison: [
    {
      rows: [
        { label: "Own API key", values: [true, true, true, true] },
        { label: "Machine hours", values: ["2 h", "50 h", "500 h", "Custom"] },
        { label: "Seats", values: ["1", "1", "Unlimited", "Unlimited"] },
        { label: "SSO", values: [false, false, false, true] },
      ],
      title: "Plans",
    },
  ],
  intro: "",
  plans: [
    plan("free", "free"),
    plan("pro", "plan_pro"),
    plan("team", "plan_team", { recommended: true }),
    plan("enterprise", null, { contactUrl: "mailto:sales@example.com" }),
  ],
  questions: [],
};

function billing(overrides: Partial<PlanBillingState> = {}): PlanBillingState {
  return {
    cancelsAtPeriodEnd: false,
    paid: false,
    planId: "plan_free",
    planPrice: 0,
    plans: [
      { id: "plan_pro", price: 100 },
      { id: "plan_team", price: 200 },
    ],
    scheduledPlanId: null,
    ...overrides,
  };
}

const [, pro, team, enterprise] = catalog.plans as [CatalogPlan, CatalogPlan, CatalogPlan, CatalogPlan];

describe("upgradePlans", () => {
  it("leaves out the free plan", () => {
    expect(upgradePlans(catalog).map((candidate) => candidate.id)).toEqual(["pro", "team", "enterprise"]);
  });
});

describe("planAdditions", () => {
  it("lists what each plan adds to the one before it", () => {
    expect(planAdditions(catalog, "pro")).toEqual({
      base: "Free",
      features: [{ label: "Machine hours", value: "50 h" }],
    });
    expect(planAdditions(catalog, "enterprise")).toEqual({
      base: "Team",
      features: [
        { label: "Machine hours", value: "Custom" },
        { label: "SSO", value: true },
      ],
    });
  });

  it("lists everything the first plan includes", () => {
    expect(planAdditions(catalog, "free")).toEqual({
      base: null,
      features: [
        { label: "Own API key", value: true },
        { label: "Machine hours", value: "2 h" },
        { label: "Seats", value: "1" },
      ],
    });
  });
});

describe("planChoice", () => {
  it("offers every paid plan as an upgrade to a free workspace", () => {
    expect([pro, team, enterprise].map((candidate) => planChoice(candidate, billing()))).toEqual([
      { kind: "change", label: "Upgrade to Pro", planId: "plan_pro", price: 100, upgrade: true },
      { kind: "change", label: "Upgrade to Team", planId: "plan_team", price: 200, upgrade: true },
      { kind: "contact", label: "Contact us", url: "mailto:sales@example.com" },
    ]);
  });

  it("offers cheaper plans as switches and marks the current plan", () => {
    const state = billing({ paid: true, planId: "plan_team", planPrice: 200 });
    expect(planChoice(pro, state)).toEqual({
      kind: "change",
      label: "Switch to Pro",
      planId: "plan_pro",
      price: 100,
      upgrade: false,
    });
    expect(planChoice(team, state)).toEqual({ kind: "current" });
  });

  it("marks a plan that starts at the end of the period", () => {
    expect(planChoice(pro, billing({ paid: true, planId: "plan_team", planPrice: 200, scheduledPlanId: "plan_pro" })))
      .toEqual({ kind: "scheduled" });
  });

  it("does not sell plans the installation does not offer", () => {
    expect(planChoice(team, billing({ plans: [{ id: "plan_pro", price: 100 }] }))).toEqual({ kind: "unavailable" });
    expect(planChoice(plan("enterprise", null), billing())).toEqual({ kind: "unavailable" });
  });
});

describe("planChoiceNote", () => {
  it("says when the plan is charged", () => {
    expect(planChoiceNote(planChoice(pro, billing()), billing())).toBe("Today: $100");
    const paidPro = billing({ paid: true, planId: "plan_pro", planPrice: 100 });
    expect(planChoiceNote(planChoice(team, paidPro), paidPro)).toBe("Charged today, prorated for this period");
    const paidTeam = billing({ paid: true, planId: "plan_team", planPrice: 200 });
    expect(planChoiceNote(planChoice(pro, paidTeam), paidTeam)).toBe("Starts at the end of this billing period");
    expect(planChoiceNote({ kind: "current" }, paidTeam)).toBeNull();
  });
});

describe("recommendedPlanId", () => {
  it("recommends the catalog's plan while it is an upgrade", () => {
    expect(recommendedPlanId(catalog, billing())).toBe("team");
    expect(recommendedPlanId(catalog, billing({ paid: true, planId: "plan_pro", planPrice: 100 }))).toBe("team");
  });

  it("recommends nothing once the workspace has that plan or more", () => {
    expect(recommendedPlanId(catalog, billing({ paid: true, planId: "plan_team", planPrice: 200 }))).toBeNull();
    const unranked = { ...catalog, plans: catalog.plans.map((candidate) => ({ ...candidate, recommended: false })) };
    expect(recommendedPlanId(unranked, billing())).toBeNull();
  });
});

describe("canUpgrade", () => {
  it("is true while a more expensive plan is for sale", () => {
    expect(canUpgrade(catalog, billing())).toBe(true);
    expect(canUpgrade(catalog, billing({ paid: true, planId: "plan_pro", planPrice: 100 }))).toBe(true);
    expect(canUpgrade(catalog, billing({ paid: true, planId: "plan_team", planPrice: 200 }))).toBe(false);
  });
});
