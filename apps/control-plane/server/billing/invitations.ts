import { APIError } from "better-auth/api";
import {
  getAutomationBillingSummary,
  type AutomationBillingSummary,
} from "../../../../packages/core/src/billing/autumn.js";
import { organizationUsesUsageBilling } from "../../../../packages/core/src/billing/usage-billing.js";
import { organizationHasCapability } from "../../../../packages/core/src/db/organization-capabilities.js";
import {
  extensionSeats,
  type ExtensionSeats,
  type ExtensionTeamPlanOffer,
} from "../extensions.js";

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

export interface WorkspaceSeats {
  needsTeamPlan: boolean;
  // Set when the extension's plan limits the workspace, so the app offers
  // the extension's Team plan rather than the automation plans.
  extensionOffer: ExtensionTeamPlanOffer | null;
}

export interface WorkspaceSeatsDependencies {
  getSummary: (organizationId: string) => Promise<Pick<AutomationBillingSummary, "includesTeammates">>;
  usesUsageBilling: (organizationId: string) => Promise<boolean>;
  extensionSeats: (organizationId: string) => Promise<ExtensionSeats>;
  hasUnlimitedSeats: (organizationId: string) => Promise<boolean>;
}

const defaultDependencies: WorkspaceSeatsDependencies = {
  getSummary: getAutomationBillingSummary,
  usesUsageBilling: organizationUsesUsageBilling,
  extensionSeats: (organizationId) => extensionSeats(organizationId),
  hasUnlimitedSeats: (organizationId) => organizationHasCapability(organizationId, "unlimited_seats"),
};

const unlimited: WorkspaceSeats = { needsTeamPlan: false, extensionOffer: null };

// Whether a workspace needs a Team plan to invite teammates. The automation
// plan, on usage billing, and the extension's plan each answer. Any plan with
// teammates is enough; a workspace needs Team only when a plan limits it and
// none includes teammates. Workspaces given unlimited seats by hand are never
// limited. Throws when a plan cannot be read.
export async function workspaceSeats(
  organizationId: string,
  dependencies: WorkspaceSeatsDependencies = defaultDependencies,
): Promise<WorkspaceSeats> {
  if (await dependencies.hasUnlimitedSeats(organizationId)) return unlimited;
  const usageBased = await dependencies.usesUsageBilling(organizationId);
  const [automations, extension] = await Promise.all([
    usageBased ? dependencies.getSummary(organizationId) : null,
    dependencies.extensionSeats(organizationId),
  ]);
  const answers = [
    automations ? automations.includesTeammates : null,
    extension.includesTeammates,
  ];
  if (!answers.includes(false) || answers.includes(true)) return unlimited;
  return {
    needsTeamPlan: true,
    extensionOffer: extension.includesTeammates === false ? extension.offer : null,
  };
}

// Runs before an invitation is created. Members who already joined stay, and
// invitations already sent can still be accepted. A billing failure does not
// stop the invitation.
export async function assertWorkspaceCanInvite(
  organizationId: string,
  dependencies: WorkspaceSeatsDependencies = defaultDependencies,
): Promise<void> {
  let seats: WorkspaceSeats;
  try {
    seats = await workspaceSeats(organizationId, dependencies);
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
  if (!seats.needsTeamPlan) return;
  console.info(
    JSON.stringify({ event: "invitation_team_plan_required", organizationId }),
  );
  throw new APIError("FORBIDDEN", {
    code: TEAM_PLAN_REQUIRED,
    message: "Inviting teammates needs the Team plan.",
  });
}
