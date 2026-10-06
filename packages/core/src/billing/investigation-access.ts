import {
  checkWorkAllowance,
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
  checkWorkAllowance,
  consumeInvestigation,
  organizationUsesUsageBilling,
  reserveInvestigation,
};

// Admits a new investigation. Usage-billed organizations start one while
// their usage credit and machine time last and pay for what it uses; the
// others spend one investigation credit.
export async function admitInvestigation(
  organizationId: string,
  investigationId: string,
  injected: typeof dependencies = dependencies,
): Promise<InvestigationAdmission> {
  if (await injected.organizationUsesUsageBilling(organizationId)) {
    const { allowed, nextResetAt } = await injected.checkWorkAllowance(organizationId, {
      responderModels: true,
    });
    return { allowed, configured: true, nextResetAt, usageBased: true };
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
    const { allowed, nextResetAt } = await injected.checkWorkAllowance(organizationId, {
      responderModels: true,
    });
    return { allowed, configured: true, nextResetAt, reservationId: null, usageBased: true };
  }
  return {
    ...(await injected.reserveInvestigation(organizationId, investigationId)),
    usageBased: false,
  };
}
