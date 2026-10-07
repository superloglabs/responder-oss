import { automationTemplates, type AutomationTemplate } from "./automation-templates";

export type OnboardingStep = "workspace" | "code" | "alerts" | "usage" | "templates";

export const onboardingStepLabels: Record<OnboardingStep, string> = {
  alerts: "Alerts",
  code: "Code",
  templates: "Go live",
  usage: "Usage",
  workspace: "Workspace",
};

// Every installation lists the same steps. The usage step offers plans only
// where billing can change them.
export const onboardingSteps: readonly OnboardingStep[] = ["workspace", "code", "alerts", "usage", "templates"];

export function onboardingPath(step: Exclude<OnboardingStep, "workspace">): string {
  return `/onboarding/${step}`;
}

// Reads the step from the URL. Unknown steps and the workspace step, which
// is complete once this page loads, open the first step after it.
export function onboardingStepFromPath(value: string | undefined): Exclude<OnboardingStep, "workspace"> {
  const step = onboardingSteps.find((candidate) => candidate === value);
  return step && step !== "workspace" ? step : "code";
}

// Providers with a working connection. Accounts that failed or were revoked
// stay listed but do not make the provider connected.
export function connectedProviders(integrations: ReadonlyArray<{ id: string; state: string }>): string[] {
  return integrations.filter((integration) => integration.state === "connected").map((integration) => integration.id);
}

export function formatPlanPrice(value: number): string {
  return Number.isInteger(value) ? `$${value}` : `$${value.toFixed(2)}`;
}

// Upgrades charge a saved payment method now; cheaper plans start when the
// billing period ends.
export function planChangeConfirmation(plan: { name: string; price: number }, currentPrice: number): string {
  return plan.price > currentPrice
    ? `Switch to ${plan.name} (${formatPlanPrice(plan.price)} / month) now? A saved payment method is charged immediately, prorated for this period.`
    : `Switch to ${plan.name} (${formatPlanPrice(plan.price)} / month) at the end of this billing period?`;
}

// Integrations offered on the alerts step, grouped by what they tell the
// agent. These are the providers the built-in templates trigger on or read.
export const onboardingAlertSources = [
  { label: "Errors and monitoring", providers: ["sentry", "datadog"] },
  { label: "Team chat", providers: ["slack", "discord"] },
] as const;

export type OnboardingProvider = "github" | (typeof onboardingAlertSources)[number]["providers"][number];

// Templates for teams that just connected their tools, most useful first.
// Sorting by connected providers can move a later template ahead.
const onboardingTemplateOrder = [
  "triage-sentry-issues",
  "triage-slack-alerts",
  "fix-sentry-regressions",
  "reliability-check",
  "fix-slack-bug-reports",
  "answer-support-questions",
  "answer-community-questions",
  "match-reports-to-errors",
  "review-observability",
  "review-performance",
  "review-testing",
  "review-architecture",
];

export function templateProviders(template: Pick<AutomationTemplate, "connectors" | "triggers">): string[] {
  const triggerProviders = template.triggers.flatMap((trigger) => trigger.kind === "schedule" ? [] : [trigger.kind]);
  return [...new Set([...triggerProviders, ...template.connectors])];
}

export interface TemplateRecommendation {
  missing: string[];
  template: AutomationTemplate;
}

// Recommends templates that work with the connected providers. Templates
// with fewer missing providers come first, then those that use more of
// what was connected, so a workspace with Sentry and Slack sees Sentry
// alerts before a weekly code review.
export function recommendedTemplates(connected: readonly string[], limit = 3): TemplateRecommendation[] {
  const connectedSet = new Set(connected);
  const rank = (id: string) => {
    const index = onboardingTemplateOrder.indexOf(id);
    return index === -1 ? onboardingTemplateOrder.length : index;
  };
  return automationTemplates
    .map((template) => {
      const providers = templateProviders(template);
      return {
        missing: providers.filter((provider) => !connectedSet.has(provider)),
        template,
        uses: providers.filter((provider) => provider !== "github" && connectedSet.has(provider)).length,
      };
    })
    .sort((left, right) =>
      left.missing.length - right.missing.length ||
      right.uses - left.uses ||
      rank(left.template.id) - rank(right.template.id))
    .slice(0, limit)
    .map(({ missing, template }) => ({ missing, template }));
}

export interface BillingPlanSummary {
  allowance: number;
  machineHours: { granted: number } | null;
  nextResetAt: number | null;
  paid: boolean;
  planId: string;
  planPrice: number;
  plans: Array<{ id: string; included: number; machineHours: number; name: string; price: number }>;
}

export interface OnboardingPlanCard {
  // Usage credit in dollars and whether it renews each month.
  credit: number;
  creditRenews: boolean;
  current: boolean;
  id: string;
  machineHours: number | null;
  name: string;
  price: number;
  recommended: boolean;
}

// The free plan is listed only while it is the current plan, because its
// credit is known only from the current summary. The cheapest paid plan is
// recommended to a free workspace.
export function onboardingPlanCards(summary: BillingPlanSummary): OnboardingPlanCard[] {
  const paidPlans = [...summary.plans].sort((left, right) => left.price - right.price);
  const free: OnboardingPlanCard[] = summary.paid
    ? []
    : [{
        credit: summary.allowance,
        creditRenews: summary.nextResetAt !== null,
        current: true,
        id: "free",
        machineHours: summary.machineHours?.granted ?? null,
        name: "Free",
        price: 0,
        recommended: false,
      }];
  return [
    ...free,
    ...paidPlans.map((plan, index) => ({
      credit: plan.included,
      creditRenews: true,
      current: summary.paid && plan.id === summary.planId,
      id: plan.id,
      machineHours: summary.machineHours ? plan.machineHours : null,
      name: plan.name,
      price: plan.price,
      recommended: !summary.paid && index === 0,
    })),
  ];
}
