import { describe, expect, it } from "vitest";
import { automationTemplates } from "./automation-templates";
import {
  connectedProviders,
  onboardingPlanCards,
  planBillingState,
  planChangeConfirmation,
  onboardingStepAtPath,
  onboardingStepFromPath,
  onboardingSteps,
  recommendedTemplates,
  templateProviders,
} from "./onboarding-presentation";
import type { CatalogPlan, PlanCatalog } from "../plan-comparison";

const ids = (connected: string[]) => recommendedTemplates(connected).map(({ template }) => template.id);

describe("onboarding steps", () => {
  it("lists the same steps on every installation", () => {
    expect(onboardingSteps).toEqual(["workspace", "code", "alerts", "usage", "templates"]);
  });

  it("opens the code step for unknown steps and the finished workspace step", () => {
    expect(onboardingStepFromPath("alerts")).toBe("alerts");
    expect(onboardingStepFromPath("plan")).toBe("code");
    expect(onboardingStepFromPath("workspace")).toBe("code");
    expect(onboardingStepFromPath(undefined)).toBe("code");
  });

  it("reads the step from setup URLs only", () => {
    expect(onboardingStepAtPath("/onboarding/usage")).toBe("usage");
    expect(onboardingStepAtPath("/onboarding/")).toBe("code");
    expect(onboardingStepAtPath("/onboarding")).toBe("code");
    expect(onboardingStepAtPath("/onboarding-guide")).toBeNull();
    expect(onboardingStepAtPath("/app")).toBeNull();
  });
});

describe("connectedProviders", () => {
  it("counts only providers with a working connection", () => {
    expect(connectedProviders([
      { id: "github", state: "connected" },
      { id: "sentry", state: "available" },
      { id: "slack", state: "setup_required" },
    ])).toEqual(["github"]);
  });
});

describe("planChangeConfirmation", () => {
  it("warns that an upgrade charges now", () => {
    expect(planChangeConfirmation({ name: "Team", price: 200 }, 100))
      .toBe("Switch to Team ($200 / month) now? A saved payment method is charged immediately, prorated for this period.");
  });

  it("says a cheaper plan starts at the end of the period", () => {
    expect(planChangeConfirmation({ name: "Pro", price: 100 }, 200))
      .toBe("Switch to Pro ($100 / month) at the end of this billing period?");
  });
});

describe("planBillingState", () => {
  const automations = { configured: true };

  it("offers plans when billing can change them", () => {
    expect(planBillingState({ automations, enabled: true })).toEqual({ billing: { automations, enabled: true }, kind: "plans" });
  });

  it("offers no plans when billing is off or not configured", () => {
    expect(planBillingState({ automations, enabled: false })).toEqual({ kind: "none" });
    expect(planBillingState({ automations: { configured: false }, enabled: true })).toEqual({ kind: "none" });
    expect(planBillingState({ automations: null, enabled: true })).toEqual({ kind: "none" });
  });

  it("reports a failed billing request instead of hiding plans", () => {
    expect(planBillingState(null)).toEqual({ kind: "error" });
  });
});

describe("recommendedTemplates", () => {
  it("lists trigger and connector providers once", () => {
    const sentryAlerts = automationTemplates.find((template) => template.id === "triage-sentry-issues")!;
    expect(templateProviders(sentryAlerts)).toEqual(["sentry", "github", "slack"]);
  });

  it("starts with Slack triage and Sentry alerts when Sentry is connected", () => {
    expect(ids(["github", "sentry", "slack"])).toEqual([
      "triage-slack-alerts",
      "triage-sentry-issues",
      "match-reports-to-errors",
    ]);
  });

  it("alerts on errors from Datadog or Grafana when Sentry is not connected", () => {
    expect(ids(["github", "datadog", "slack"]).slice(0, 2)).toEqual(["triage-slack-alerts", "alert-on-critical-datadog-errors"]);
    expect(ids(["github", "grafana", "slack"]).slice(0, 2)).toEqual(["triage-slack-alerts", "alert-on-critical-grafana-errors"]);
    expect(ids(["github", "sentry", "grafana", "slack"]).slice(0, 2)).toEqual(["triage-slack-alerts", "triage-sentry-issues"]);
  });

  it("offers one error alert even when several error tools are connected", () => {
    const alerts = ids(["github", "sentry", "datadog", "grafana", "slack"])
      .filter((id) => ["triage-sentry-issues", "alert-on-critical-datadog-errors", "alert-on-critical-grafana-errors"].includes(id));
    expect(alerts).toEqual(["triage-sentry-issues"]);
  });

  it("triages Slack alerts with the error tools the workspace connected", () => {
    const [triage] = recommendedTemplates(["github", "grafana", "slack"]);
    expect(triage).toMatchObject({ missing: [], providers: ["slack", "grafana", "github"] });
    const [unconnected] = recommendedTemplates(["github"]);
    expect(unconnected).toMatchObject({ missing: ["slack", "sentry"], providers: ["slack", "sentry", "github"] });
  });

  it("puts the reliability check third when Sentry, Datadog, and Slack are connected", () => {
    expect(ids(["github", "sentry", "datadog", "slack"])[2]).toBe("reliability-check");
  });

  it("recommends community answers to a Discord workspace after the first two", () => {
    expect(ids(["github", "discord"])[2]).toBe("answer-community-questions");
  });

  it("recommends what needs the fewest connections after the first two", () => {
    const [, , third] = recommendedTemplates(["github"]);
    expect(third).toMatchObject({ missing: [], template: { id: "update-docs" } });
  });

  it("names the providers a recommendation still needs", () => {
    const [first] = recommendedTemplates([]);
    expect(first.missing).toContain("github");
  });
});

describe("onboardingPlanCards", () => {
  const plans = [
    { id: "team", included: 200, machineHours: 500, name: "Team", price: 200 },
    { id: "pro", included: 100, machineHours: 50, name: "Pro", price: 100 },
  ];
  const catalogPlan = (billingPlanId: string, details: Partial<CatalogPlan>): CatalogPlan => ({
    action: "Choose",
    audience: "",
    badge: "",
    billingPlanId,
    description: "",
    id: billingPlanId,
    label: "",
    name: billingPlanId,
    price: "",
    unit: "",
    ...details,
  });
  const catalog: PlanCatalog = { comparison: [], intro: "", plans: [], questions: [] };

  it("lists the free plan first and recommends the cheapest paid plan", () => {
    const cards = onboardingPlanCards({
      allowance: 5,
      machineHours: { granted: 2 },
      nextResetAt: null,
      paid: false,
      planId: "free",
      planPrice: 0,
      plans,
    }, catalog);
    expect(cards.map((card) => [card.id, card.current, card.recommended])).toEqual([
      ["free", true, false],
      ["pro", false, true],
      ["team", false, false],
    ]);
    expect(cards[0]).toMatchObject({ credit: 5, creditRenews: false, machineHours: 2 });
    expect(cards[1]).toMatchObject({ credit: 100, creditRenews: true, machineHours: 50 });
  });

  it("marks the paid plan in use and leaves out the free plan", () => {
    const cards = onboardingPlanCards({
      allowance: 100,
      machineHours: { granted: 50 },
      nextResetAt: 1,
      paid: true,
      planId: "pro",
      planPrice: 100,
      plans,
    }, catalog);
    expect(cards.map((card) => [card.id, card.current, card.recommended])).toEqual([
      ["pro", true, false],
      ["team", false, false],
    ]);
  });

  it("describes each plan from the catalog", () => {
    const cards = onboardingPlanCards({
      allowance: 5,
      machineHours: { granted: 2 },
      nextResetAt: null,
      paid: false,
      planId: "free",
      planPrice: 0,
      plans,
    }, {
      ...catalog,
      plans: [
        catalogPlan("free", { audience: "For trying it out", highlights: ["1 seat"] }),
        catalogPlan("team", { audience: "For teams", highlights: ["Unlimited seats", "Priority support"] }),
      ],
    });
    expect(cards.map((card) => [card.id, card.audience, card.highlights])).toEqual([
      ["free", "For trying it out", ["1 seat"]],
      ["pro", null, []],
      ["team", "For teams", ["Unlimited seats", "Priority support"]],
    ]);
  });

  it("omits machine hours on plans that pay for sandbox time from the credit", () => {
    const cards = onboardingPlanCards({
      allowance: 5,
      machineHours: null,
      nextResetAt: 1,
      paid: false,
      planId: "free",
      planPrice: 0,
      plans,
    }, catalog);
    expect(cards.every((card) => card.machineHours === null)).toBe(true);
  });
});
