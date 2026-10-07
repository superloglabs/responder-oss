import { describe, expect, it } from "vitest";
import { automationTemplates } from "./automation-templates";
import {
  onboardingPlanCards,
  onboardingStepFromPath,
  onboardingSteps,
  recommendedTemplates,
  templateProviders,
} from "./onboarding-presentation";

const ids = (connected: string[]) => recommendedTemplates(connected).map(({ template }) => template.id);

describe("onboarding steps", () => {
  it("includes the plan step only when billing is available", () => {
    expect(onboardingSteps(true)).toEqual(["workspace", "code", "alerts", "plan", "templates"]);
    expect(onboardingSteps(false)).toEqual(["workspace", "code", "alerts", "templates"]);
  });

  it("opens the code step for unknown steps and the finished workspace step", () => {
    expect(onboardingStepFromPath("alerts", onboardingSteps(true))).toBe("alerts");
    expect(onboardingStepFromPath("plan", onboardingSteps(false))).toBe("code");
    expect(onboardingStepFromPath("workspace", onboardingSteps(true))).toBe("code");
    expect(onboardingStepFromPath(undefined, onboardingSteps(true))).toBe("code");
  });
});

describe("recommendedTemplates", () => {
  it("lists trigger and connector providers once", () => {
    const sentryAlerts = automationTemplates.find((template) => template.id === "triage-sentry-issues")!;
    expect(templateProviders(sentryAlerts)).toEqual(["sentry", "github", "slack"]);
  });

  it("recommends Sentry and Slack triage to a workspace with both", () => {
    expect(ids(["github", "sentry", "slack"])).toEqual([
      "triage-sentry-issues",
      "triage-slack-alerts",
      "match-reports-to-errors",
    ]);
  });

  it("puts the reliability check first when Sentry, Datadog, and Slack are connected", () => {
    expect(ids(["github", "sentry", "datadog", "slack"])[0]).toBe("reliability-check");
  });

  it("recommends community answers to a Discord workspace", () => {
    expect(ids(["github", "discord"])[0]).toBe("answer-community-questions");
  });

  it("recommends what needs the fewest connections when only GitHub is connected", () => {
    const recommendations = recommendedTemplates(["github"]);
    expect(recommendations).toHaveLength(3);
    expect(recommendations.every(({ missing }) => missing.length === 1)).toBe(true);
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

  it("lists the free plan first and recommends the cheapest paid plan", () => {
    const cards = onboardingPlanCards({
      allowance: 5,
      machineHours: { granted: 2 },
      nextResetAt: null,
      paid: false,
      planId: "free",
      plans,
    });
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
      plans,
    });
    expect(cards.map((card) => [card.id, card.current, card.recommended])).toEqual([
      ["pro", true, false],
      ["team", false, false],
    ]);
  });

  it("omits machine hours on plans that pay for sandbox time from the credit", () => {
    const cards = onboardingPlanCards({
      allowance: 5,
      machineHours: null,
      nextResetAt: 1,
      paid: false,
      planId: "free",
      plans,
    });
    expect(cards.every((card) => card.machineHours === null)).toBe(true);
  });
});
