import {
  checkUsageAllowance,
  consumeInvestigation,
  reserveInvestigation,
  type InvestigationAccess,
  type InvestigationReservationAccess,
} from "./autumn.js";
import { organizationUsesUsageBilling } from "./usage-billing.js";

export interface InvestigationAdmission extends InvestigationAccess {
  usageBased: boolean;
}

export interface InvestigationRetryAdmission extends InvestigationReservationAccess {
  usageBased: boolean;
}

const dependencies = {
  checkUsageAllowance,
  consumeInvestigation,
  organizationUsesUsageBilling,
  reserveInvestigation,
};

// Admits a new investigation. Usage-billed organizations start one while
// their usage allowance lasts and pay for what it uses; the others spend one
// investigation credit.
export async function admitInvestigation(
  organizationId: string,
  investigationId: string,
  injected: typeof dependencies = dependencies,
): Promise<InvestigationAdmission> {
  if (await injected.organizationUsesUsageBilling(organizationId)) {
    const access = await injected.checkUsageAllowance(organizationId);
    return { ...access, configured: true, usageBased: true };
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
    const access = await injected.checkUsageAllowance(organizationId);
    return { ...access, configured: true, reservationId: null, usageBased: true };
  }
  return {
    ...(await injected.reserveInvestigation(organizationId, investigationId)),
    usageBased: false,
  };
}
