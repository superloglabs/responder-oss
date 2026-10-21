// Plans a workspace compares before it changes plan. The edition's plan
// catalog supplies what each plan includes; the billing summary decides what
// choosing each plan does.

// A comparison value: text, or whether the plan includes the feature.
export type PlanComparisonValue = string | boolean;

export interface CatalogPlan {
  // Call to action on the public pricing page.
  action: string;
  audience: string;
  badge: string;
  // What the plan change endpoint accepts for this plan: "free" or a paid
  // plan ID. Null for a plan sold through `contactUrl`.
  billingPlanId: string | null;
  // Where the billing page sends a workspace that asks about the plan.
  contactUrl?: string;
  description: string;
  // Short lines guided setup lists on the plan card, after the usage credit
  // and machine hours, such as seats and support.
  highlights?: readonly string[];
  id: string;
  // Short use case shown above the name.
  label: string;
  name: string;
  price: string;
  // Highlighted in the plan dialog while the workspace can upgrade to it.
  recommended?: boolean;
  // Shown after the price, such as "/ month". Empty for custom pricing.
  unit: string;
}

export interface PlanComparisonRow {
  label: string;
  note?: string;
  // The row holds each plan's seat count, which plan cards also show.
  seats?: boolean;
  // One value per catalog plan, in catalog order.
  values: readonly PlanComparisonValue[];
}

export interface PlanComparisonGroup {
  rows: readonly PlanComparisonRow[];
  title: string;
}

export interface PlanQuestion {
  answer: string;
  question: string;
}

export interface PlanCatalog {
  comparison: readonly PlanComparisonGroup[];
  // How the plans differ, in one or two sentences.
  intro: string;
  plans: readonly CatalogPlan[];
  questions: readonly PlanQuestion[];
}

export const FREE_PLAN_CHOICE = "free";

// Plans a workspace can move up to. The free plan is reached by cancelling.
export function upgradePlans(catalog: PlanCatalog): CatalogPlan[] {
  return catalog.plans.filter((plan) => plan.billingPlanId !== FREE_PLAN_CHOICE);
}

export interface PlanFeature {
  label: string;
  value: PlanComparisonValue;
}

// What a plan adds to the plan listed before it, read from the comparison
// table: every row whose value differs.
export function planAdditions(
  catalog: PlanCatalog,
  planId: string,
): { base: string | null; features: PlanFeature[] } {
  const index = catalog.plans.findIndex((plan) => plan.id === planId);
  const base = index > 0 ? catalog.plans[index - 1]! : null;
  const features = catalog.comparison.flatMap((group) => group.rows).flatMap((row) => {
    const value = row.values[index];
    if (value === undefined || value === false) return [];
    if (base && row.values[index - 1] === value) return [];
    return [{ label: row.label, value }];
  });
  return { base: base?.name ?? null, features };
}

// The plan's seats, such as "1 seat" or "Unlimited seats", read from the
// comparison row that holds them.
export function planSeats(catalog: PlanCatalog, planId: string): string | null {
  const index = catalog.plans.findIndex((plan) => plan.id === planId);
  const row = catalog.comparison.flatMap((group) => group.rows).find((candidate) => candidate.seats);
  const value = index === -1 ? undefined : row?.values[index];
  if (typeof value !== "string") return null;
  return `${value} ${value === "1" ? "seat" : "seats"}`;
}

export interface PlanBillingState {
  cancelsAtPeriodEnd: boolean;
  paid: boolean;
  planId: string;
  planPrice: number;
  // Paid plans the workspace can switch to.
  plans: ReadonlyArray<{ id: string; price: number }>;
  scheduledPlanId: string | null;
}

export type PlanChoice =
  | { kind: "change"; label: string; planId: string; upgrade: boolean }
  | { kind: "contact"; label: string; url: string }
  | { kind: "current" }
  // Starts at the end of the billing period.
  | { kind: "scheduled" }
  // This installation cannot sell the plan.
  | { kind: "unavailable" };

export function planChoice(plan: CatalogPlan, billing: PlanBillingState): PlanChoice {
  if (plan.billingPlanId === null) {
    return plan.contactUrl
      ? { kind: "contact", label: "Contact us", url: plan.contactUrl }
      : { kind: "unavailable" };
  }
  const paidPlan = billing.plans.find((candidate) => candidate.id === plan.billingPlanId);
  if (!paidPlan) return { kind: "unavailable" };
  if (billing.paid && billing.planId === paidPlan.id) return { kind: "current" };
  if (billing.scheduledPlanId === paidPlan.id) return { kind: "scheduled" };
  const upgrade = paidPlan.price > billing.planPrice;
  return {
    kind: "change",
    label: `${upgrade ? "Upgrade to" : "Switch to"} ${plan.name}`,
    planId: paidPlan.id,
    upgrade,
  };
}

// The catalog's recommended plan, while choosing it is an upgrade.
export function recommendedPlanId(catalog: PlanCatalog, billing: PlanBillingState): string | null {
  const plan = catalog.plans.find((candidate) => candidate.recommended);
  if (!plan) return null;
  const choice = planChoice(plan, billing);
  return choice.kind === "change" && choice.upgrade ? plan.id : null;
}

// Whether the workspace can switch to a plan that costs more.
export function canUpgrade(catalog: PlanCatalog, billing: PlanBillingState): boolean {
  return upgradePlans(catalog).some((plan) => {
    const choice = planChoice(plan, billing);
    return choice.kind === "change" && choice.upgrade;
  });
}
