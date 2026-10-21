import { APIError } from "better-auth/api";
import {
  getAutomationBillingSummary,
  type AutomationBillingSummary,
} from "../../../../packages/core/src/billing/autumn.js";
import { organizationUsesUsageBilling } from "../../../../packages/core/src/billing/usage-billing.js";

// The error code of an invitation refused for the plan, so the app can offer
// Team instead.
export const TEAM_PLAN_REQUIRED = "TEAM_PLAN_REQUIRED";

// Free and Pro have one seat. Workspaces on investigation billing, and
// deployments without billing, are not limited.
export function invitationsNeedTeamPlan(billing: {
  automations: Pick<AutomationBillingSummary, "includesTeammates"> | null;
  usageBased: boolean;
}): boolean {
  return billing.usageBased && billing.automations?.includesTeammates === false;
}

// Runs before an invitation is created. Members who already joined stay, and
// invitations already sent can still be accepted. A billing failure does not
// stop the invitation.
export async function assertWorkspaceCanInvite(
  organizationId: string,
  dependencies: {
    getSummary: (organizationId: string) => Promise<AutomationBillingSummary>;
    usesUsageBilling: (organizationId: string) => Promise<boolean>;
  } = {
    getSummary: getAutomationBillingSummary,
    usesUsageBilling: organizationUsesUsageBilling,
  },
): Promise<void> {
  let needsTeamPlan: boolean;
  try {
    const usageBased = await dependencies.usesUsageBilling(organizationId);
    needsTeamPlan = usageBased && invitationsNeedTeamPlan({
      automations: await dependencies.getSummary(organizationId),
      usageBased,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        errorCode: error instanceof Error ? error.constructor.name : "unknown",
        event: "invitation_plan_check_failed",
        organizationId,
      }),
    );
    return;
  }
  if (!needsTeamPlan) return;
  console.info(
    JSON.stringify({ event: "invitation_team_plan_required", organizationId }),
  );
  throw new APIError("FORBIDDEN", {
    code: TEAM_PLAN_REQUIRED,
    message: "Inviting teammates needs the Team plan.",
  });
}
