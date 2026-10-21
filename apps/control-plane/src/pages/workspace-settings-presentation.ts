import { formatPlanPrice } from "./onboarding-presentation";

// The server refuses an invitation with this code when the plan has one seat.
export const teamPlanRequiredCode = "TEAM_PLAN_REQUIRED";

export interface TeamPlan {
  id: string;
  included: number;
  includesTeammates?: boolean;
  machineHours: number;
  name: string;
  price: number;
}

// The cheapest plan that lets the workspace invite teammates.
export function teammatePlan(billing: {
  automations: { plans: TeamPlan[] } | null;
}): TeamPlan | null {
  return [...(billing.automations?.plans ?? [])]
    .filter((plan) => plan.includesTeammates)
    .sort((left, right) => left.price - right.price)[0] ?? null;
}

export function teamPlanDescription(plan: TeamPlan | null): string {
  if (!plan) return "Your plan includes one seat. Choose a plan with unlimited seats to invite teammates.";
  return `Your plan includes one seat. ${plan.name} includes unlimited seats, ${formatPlanPrice(plan.included)} of usage credit and ${plan.machineHours} machine hours each month, for ${formatPlanPrice(plan.price)} / month.`;
}
