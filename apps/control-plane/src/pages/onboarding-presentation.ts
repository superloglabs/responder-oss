import { automationTemplates, type AutomationTemplate } from "./automation-templates";
import type { PlanCatalog } from "../plan-comparison";

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

export type OnboardingStage = "alert" | "cause" | "fix";

// The explainer stages each step highlights. Steps without an entry take the
// full width.
export const onboardingStepStages: Partial<Record<OnboardingStep, OnboardingStage[]>> = {
  alerts: ["alert"],
  code: ["cause", "fix"],
  workspace: [],
};

export function onboardingPath(step: Exclude<OnboardingStep, "workspace">): string {
  return `/onboarding/${step}`;
}

// Reads the step from the URL. Unknown steps and the workspace step, which
// is complete once this page loads, open the first step after it.
export function onboardingStepFromPath(value: string | undefined): Exclude<OnboardingStep, "workspace"> {
  const step = onboardingSteps.find((candidate) => candidate === value);
  return step && step !== "workspace" ? step : "code";
}

// The step a setup URL opens, or null outside guided setup.
export function onboardingStepAtPath(pathname: string): Exclude<OnboardingStep, "workspace"> | null {
  const match = /^\/onboarding(?:\/([^/]*))?\/?$/.exec(pathname);
  return match ? onboardingStepFromPath(match[1]) : null;
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
// agent: where errors and alerts come from, and where the team discusses them.
export const onboardingAlertSources = [
  { label: "Errors and monitoring", providers: ["sentry", "datadog", "grafana"] },
  { label: "Team chat", providers: ["slack", "discord"] },
] as const;

export type OnboardingProvider = "github" | (typeof onboardingAlertSources)[number]["providers"][number];

// Error tools, in the order their error alerts are preferred: Sentry starts
// a run on each new issue, while Datadog and Grafana are checked every hour.
const errorSources = ["sentry", "datadog", "grafana"] as const;

const criticalErrorTemplateIds: Record<(typeof errorSources)[number], string> = {
  datadog: "alert-on-critical-datadog-errors",
  grafana: "alert-on-critical-grafana-errors",
  sentry: "triage-sentry-issues",
};

// Templates offered after the two every setup starts with, most useful
// first. Sorting by connected providers can move a later template ahead.
const onboardingTemplateOrder = [
  "fix-sentry-regressions",
  "reliability-check",
  "fix-slack-bug-reports",
  "answer-support-questions",
  "answer-community-questions",
  "match-reports-to-errors",
  "review-observability",
  "review-performance",
  "review-testing",
  "update-docs",
  "review-architecture",
];

export function templateProviders(template: Pick<AutomationTemplate, "connectors" | "triggers">): string[] {
  const triggerProviders = template.triggers.flatMap((trigger) => trigger.kind === "schedule" ? [] : [trigger.kind]);
  return [...new Set([...triggerProviders, ...template.connectors])];
}

// The providers a template uses in a workspace. A template that reads every
// error tool needs only one: the connected ones, or Sentry when none is.
export function workspaceTemplateProviders(template: Pick<AutomationTemplate, "connectors" | "triggers">, connected: ReadonlySet<string>): string[] {
  const providers = templateProviders(template);
  if (!errorSources.every((source) => template.connectors.includes(source))) return providers;
  const connectedSources = errorSources.filter((source) => connected.has(source));
  const used: readonly string[] = connectedSources.length ? connectedSources : [errorSources[0]];
  return providers.filter((provider) => !(errorSources as readonly string[]).includes(provider) || used.includes(provider));
}

export interface TemplateRecommendation {
  missing: string[];
  providers: string[];
  template: AutomationTemplate;
}

// Every setup starts with triaging alerts in Slack and alerting on critical
// errors from the connected error tool. The rest work with the connected
// providers: templates with fewer missing providers come first, then those
// that use more of what was connected.
export function recommendedTemplates(connected: readonly string[], limit = 3): TemplateRecommendation[] {
  const connectedSet = new Set(connected);
  const source = errorSources.find((candidate) => connectedSet.has(candidate)) ?? errorSources[0];
  const pinned = ["triage-slack-alerts", criticalErrorTemplateIds[source]];
  const offeredLater = new Set([...pinned, ...Object.values(criticalErrorTemplateIds)]);
  const rank = (id: string) => {
    const index = onboardingTemplateOrder.indexOf(id);
    return index === -1 ? onboardingTemplateOrder.length : index;
  };
  const recommend = (template: AutomationTemplate) => {
    const providers = workspaceTemplateProviders(template, connectedSet);
    return {
      missing: providers.filter((provider) => !connectedSet.has(provider)),
      providers,
      template,
      uses: providers.filter((provider) => provider !== "github" && connectedSet.has(provider)).length,
    };
  };
  const first = pinned.flatMap((id) => {
    const template = automationTemplates.find((candidate) => candidate.id === id);
    return template ? [recommend(template)] : [];
  });
  const rest = automationTemplates
    .filter((template) => !offeredLater.has(template.id))
    .map(recommend)
    .sort((left, right) =>
      left.missing.length - right.missing.length ||
      right.uses - left.uses ||
      rank(left.template.id) - rank(right.template.id));
  return [...first, ...rest]
    .slice(0, limit)
    .map(({ missing, providers, template }) => ({ missing, providers, template }));
}

export type PlanBillingState<Billing> =
  | { billing: Billing; kind: "plans" }
  | { kind: "error" }
  | { kind: "none" };

// Reads the billing response for the usage step. A failed request is an
// error to retry, not an installation without plans.
export function planBillingState<Billing extends { automations: { configured: boolean } | null; enabled: boolean }>(
  billing: Billing | null,
): PlanBillingState<Billing> {
  if (!billing) return { kind: "error" };
  return billing.enabled && billing.automations?.configured ? { billing, kind: "plans" } : { kind: "none" };
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
  // Who the plan is for, from the plan catalog.
  audience: string | null;
  // Usage credit in dollars and whether it renews each month.
  credit: number;
  creditRenews: boolean;
  current: boolean;
  // What else the plan includes, from the plan catalog.
  highlights: readonly string[];
  id: string;
  machineHours: number | null;
  name: string;
  price: number;
  recommended: boolean;
}

// The free plan is listed only while it is the current plan, because its
// credit is known only from the current summary. The cheapest paid plan is
// recommended to a free workspace. The catalog describes each plan the way
// the pricing page does.
export function onboardingPlanCards(summary: BillingPlanSummary, catalog: PlanCatalog): OnboardingPlanCard[] {
  const described = (id: string) => {
    const plan = catalog.plans.find((candidate) => candidate.billingPlanId === id);
    return { audience: plan?.audience ?? null, highlights: plan?.highlights ?? [] };
  };
  const paidPlans = [...summary.plans].sort((left, right) => left.price - right.price);
  const free: OnboardingPlanCard[] = summary.paid
    ? []
    : [{
        credit: summary.allowance,
        creditRenews: summary.nextResetAt !== null,
        current: true,
        ...described("free"),
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
      ...described(plan.id),
      id: plan.id,
      machineHours: summary.machineHours ? plan.machineHours : null,
      name: plan.name,
      price: plan.price,
      recommended: !summary.paid && index === 0,
    })),
  ];
}
