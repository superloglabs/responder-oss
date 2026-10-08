import {
  checkWorkAllowance,
  consumeInvestigation,
  reserveInvestigation,
  type InvestigationAccess,
  type InvestigationReservationAccess,
} from "./autumn.js";
import { usageLimitFromAllowance, type UsageLimit } from "./usage-limit.js";
import { organizationUsesUsageBilling } from "./usage-billing.js";

export interface InvestigationAdmission extends InvestigationAccess {
  usageBased: boolean;
  // The balance that stopped a usage-billed investigation.
  usageLimit?: UsageLimit;
}

export interface InvestigationRetryAdmission extends InvestigationReservationAccess {
  usageBased: boolean;
  usageLimit?: UsageLimit;
}

const dependencies = {
  checkWorkAllowance,
  consumeInvestigation,
  organizationUsesUsageBilling,
  reserveInvestigation,
};

// Admits a new investigation. Usage-billed organizations start one while
// their usage credit and machine time last, or while their plan bills usage
// past them, and pay for what it uses; the others spend one investigation
// credit.
export async function admitInvestigation(
  organizationId: string,
  investigationId: string,
  injected: typeof dependencies = dependencies,
): Promise<InvestigationAdmission> {
  if (await injected.organizationUsesUsageBilling(organizationId)) {
    const access = await injected.checkWorkAllowance(organizationId, {
      responderModels: true,
    });
    return {
      allowed: access.allowed,
      configured: true,
      nextResetAt: access.nextResetAt,
      usageBased: true,
      usageLimit: usageLimitFromAllowance(access, true),
    };
  }
  return {
    ...(await injected.consumeInvestigation(organizationId, investigationId)),
    usageBased: false,
  };
}

// Admits a rerun. Credit-billed organizations hold a credit that the caller
// confirms or releases; usage-billed organizations need no reservation.
export async function admitInvestigationRetry(
  organizationId: string,
  investigationId: string,
  injected: typeof dependencies = dependencies,
): Promise<InvestigationRetryAdmission> {
  if (await injected.organizationUsesUsageBilling(organizationId)) {
    const access = await injected.checkWorkAllowance(organizationId, {
      responderModels: true,
    });
    return {
      allowed: access.allowed,
      configured: true,
      nextResetAt: access.nextResetAt,
      reservationId: null,
      usageBased: true,
      usageLimit: usageLimitFromAllowance(access, true),
    };
  }
  return {
    ...(await injected.reserveInvestigation(organizationId, investigationId)),
    usageBased: false,
  };
}
