import { randomUUID } from "node:crypto";
import { Autumn, type Customer } from "autumn-js";

export const INVESTIGATIONS_FEATURE_ID = "responder_investigations";
export const FREE_PLAN_ID = "responder_free";
export const PAYG_PLAN_ID = "responder_pay_as_you_go";
export const INCLUDED_INVESTIGATIONS = 50;
export const OVERAGE_PRICE_DOLLARS = 1.5;

export interface BillingCustomerData {
  email?: string;
  name?: string;
}

export interface BillingSummary {
  configured: boolean;
  enabled: boolean;
  included: number;
  nextResetAt: number | null;
  overagePrice: number;
  payAsYouGo: boolean;
  remaining: number;
  usage: number;
}

export interface InvestigationAccess {
  allowed: boolean;
  configured: boolean;
  nextResetAt: number | null;
}

export interface InvestigationReservationAccess extends InvestigationAccess {
  reservationId: string | null;
}

let autumnClient: Autumn | undefined;
let autumnClientKey: string | undefined;

export function billingIsEnabled(): boolean {
  return process.env.BILLING_ENABLED === "true";
}

function getAutumnClient(): Autumn | null {
  const secretKey = process.env.AUTUMN_SECRET_KEY;
  if (!secretKey) return null;

  if (!autumnClient || autumnClientKey !== secretKey) {
    autumnClient = new Autumn({ secretKey });
    autumnClientKey = secretKey;
  }

  return autumnClient;
}

function requireAutumnClient(): Autumn {
  const client = getAutumnClient();
  if (!client) throw new Error("Autumn billing is not configured");
  return client;
}

async function getOrCreateCustomer(
  client: Autumn,
  organizationId: string,
  data: BillingCustomerData = {},
): Promise<Customer> {
  return client.customers.getOrCreate({
    customerId: organizationId,
    autoEnablePlanId: FREE_PLAN_ID,
    email: data.email,
    name: data.name,
    metadata: { responderOrganizationId: organizationId },
  });
}

export async function consumeInvestigation(
  organizationId: string,
  investigationId: string,
): Promise<InvestigationAccess> {
  if (!billingIsEnabled()) {
    return {
      allowed: true,
      configured: false,
      nextResetAt: null,
    };
  }
  const client = getAutumnClient();
  if (!client) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("AUTUMN_SECRET_KEY is required in production");
    }
    return {
      allowed: true,
      configured: false,
      nextResetAt: null,
    };
  }

  const customer = await getOrCreateCustomer(client, organizationId);
  if (customer.id === null) {
    // Autumn's SDK fails open during a provider outage. Preserve that behavior so
    // incident response is not taken down by the billing system.
    return {
      allowed: true,
      configured: true,
      nextResetAt: null,
    };
  }

  const result = await client.check({
    customerId: organizationId,
    featureId: INVESTIGATIONS_FEATURE_ID,
    requiredBalance: 1,
    sendEvent: true,
    properties: { investigationId },
  });

  return {
    allowed: result.allowed,
    configured: true,
    nextResetAt: result.balance?.nextResetAt ?? null,
  };
}

const investigationReservationLifetimeMs = 5 * 60 * 1000;

export async function reserveInvestigation(
  organizationId: string,
  investigationId: string,
): Promise<InvestigationReservationAccess> {
  if (!billingIsEnabled()) {
    return {
      allowed: true,
      configured: false,
      nextResetAt: null,
      reservationId: null,
    };
  }
  const client = getAutumnClient();
  if (!client) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("AUTUMN_SECRET_KEY is required in production");
    }
    return {
      allowed: true,
      configured: false,
      nextResetAt: null,
      reservationId: null,
    };
  }

  const customer = await getOrCreateCustomer(client, organizationId);
  if (customer.id === null) {
    return {
      allowed: true,
      configured: true,
      nextResetAt: null,
      reservationId: null,
    };
  }

  const reservationId = `investigation-rerun:${randomUUID()}`;
  // An expiring provider-side lock makes abandoned or failed rerun claims
  // self-releasing even if this process cannot send a release request.
  const result = await client.check({
    customerId: organizationId,
    featureId: INVESTIGATIONS_FEATURE_ID,
    requiredBalance: 1,
    sendEvent: true,
    properties: { investigationId },
    lock: {
      enabled: true,
      expiresAt: Date.now() + investigationReservationLifetimeMs,
      lockId: reservationId,
    },
  });

  return {
    allowed: result.allowed,
    configured: true,
    nextResetAt: result.balance?.nextResetAt ?? null,
    reservationId: result.allowed ? reservationId : null,
  };
}

export async function finalizeInvestigationReservation(
  reservationId: string,
  action: "confirm" | "release",
): Promise<void> {
  if (!billingIsEnabled()) return;
  await requireAutumnClient().balances.finalize(
    {
      action,
      lockId: reservationId,
    },
    {
      retries: {
        strategy: "backoff",
        retryConnectionErrors: true,
      },
    },
  );
}

export function summarizeBillingCustomer(customer: Customer): BillingSummary {
  const balance = customer.balances[INVESTIGATIONS_FEATURE_ID];
  const payAsYouGo = customer.subscriptions.some(
    (subscription) =>
      subscription.planId === PAYG_PLAN_ID && subscription.status === "active",
  );

  return {
    configured: true,
    enabled: true,
    included: INCLUDED_INVESTIGATIONS,
    nextResetAt: balance?.nextResetAt ?? null,
    overagePrice: OVERAGE_PRICE_DOLLARS,
    payAsYouGo,
    remaining: Math.max(0, balance?.remaining ?? INCLUDED_INVESTIGATIONS),
    usage: Math.max(0, balance?.usage ?? 0),
  };
}

export async function getBillingSummary(
  organizationId: string,
  data?: BillingCustomerData,
): Promise<BillingSummary> {
  if (!billingIsEnabled()) {
    return {
      configured: false,
      enabled: false,
      included: INCLUDED_INVESTIGATIONS,
      nextResetAt: null,
      overagePrice: OVERAGE_PRICE_DOLLARS,
      payAsYouGo: false,
      remaining: INCLUDED_INVESTIGATIONS,
      usage: 0,
    };
  }
  const client = getAutumnClient();
  if (!client) {
    return {
      configured: false,
      enabled: true,
      included: INCLUDED_INVESTIGATIONS,
      nextResetAt: null,
      overagePrice: OVERAGE_PRICE_DOLLARS,
      payAsYouGo: false,
      remaining: INCLUDED_INVESTIGATIONS,
      usage: 0,
    };
  }

  const customer = await getOrCreateCustomer(client, organizationId, data);
  return summarizeBillingCustomer(customer);
}

export async function createPayAsYouGoCheckout(
  organizationId: string,
  successUrl: string,
  data?: BillingCustomerData,
): Promise<string> {
  if (!billingIsEnabled()) throw new Error("Billing is disabled");
  const client = requireAutumnClient();
  await getOrCreateCustomer(client, organizationId, data);
  const result = await client.billing.setupPayment({
    customerId: organizationId,
    planId: PAYG_PLAN_ID,
    successUrl,
    carryOverUsages: {
      enabled: true,
      featureIds: [INVESTIGATIONS_FEATURE_ID],
    },
  });
  return result.url;
}

export async function createBillingPortal(
  organizationId: string,
  returnUrl: string,
): Promise<string> {
  if (!billingIsEnabled()) throw new Error("Billing is disabled");
  const client = requireAutumnClient();
  const result = await client.billing.openCustomerPortal({
    customerId: organizationId,
    returnUrl,
  });
  return result.url;
}

// Automation inference is metered in US dollars against a separate plan group,
// so automation plans change independently of investigation billing.
export const AUTOMATION_INFERENCE_FEATURE_ID = "responder_automation_inference";
export const AUTOMATION_FREE_PLAN_ID = "responder_automations_free";
export const AUTOMATION_PAID_PLANS = [
  { id: "responder_automations_100", included: 100, price: 100 },
  { id: "responder_automations_200", included: 200, price: 200 },
] as const;
export const AUTOMATION_FREE_ALLOWANCE_DOLLARS = 20;

// A run may start while at least one cent of the allowance remains.
const automationMinimumBalanceDollars = 0.01;

export type AutomationPaidPlanId = (typeof AUTOMATION_PAID_PLANS)[number]["id"];
export type AutomationPlanId = typeof AUTOMATION_FREE_PLAN_ID | AutomationPaidPlanId;

const automationPlanIds: readonly string[] = [
  AUTOMATION_FREE_PLAN_ID,
  ...AUTOMATION_PAID_PLANS.map((plan) => plan.id),
];

export function isAutomationPaidPlanId(value: unknown): value is AutomationPaidPlanId {
  return AUTOMATION_PAID_PLANS.some((plan) => plan.id === value);
}

export interface AutomationBillingSummary {
  allowance: number;
  cancelsAtPeriodEnd: boolean;
  configured: boolean;
  enabled: boolean;
  nextResetAt: number | null;
  planId: AutomationPlanId;
  plans: Array<{ id: AutomationPaidPlanId; included: number; price: number }>;
  remaining: number;
  scheduledPlanId: AutomationPlanId | null;
  usage: number;
}

export interface AutomationInferenceAccess {
  allowed: boolean;
  nextResetAt: number | null;
}

function automationPlanFromCustomer(customer: Customer): {
  active: AutomationPlanId | null;
  cancelsAtPeriodEnd: boolean;
  scheduled: AutomationPlanId | null;
} {
  const find = (status: "active" | "scheduled") =>
    customer.subscriptions.find(
      (subscription) =>
        subscription.status === status &&
        automationPlanIds.includes(subscription.planId),
    );
  const active = find("active");
  return {
    active: (active?.planId as AutomationPlanId | undefined) ?? null,
    cancelsAtPeriodEnd: active?.canceledAt != null,
    scheduled: (find("scheduled")?.planId as AutomationPlanId | undefined) ?? null,
  };
}

// The Autumn account is shared with another product, so the free automation
// plan is not auto-enabled. Attach it the first time an organization needs it.
async function ensureAutomationPlan(
  client: Autumn,
  organizationId: string,
  data?: BillingCustomerData,
): Promise<Customer> {
  const customer = await getOrCreateCustomer(client, organizationId, data);
  if (customer.id === null || automationPlanFromCustomer(customer).active) {
    return customer;
  }
  await client.billing.attach({
    customerId: organizationId,
    planId: AUTOMATION_FREE_PLAN_ID,
    redirectMode: "never",
  });
  return getOrCreateCustomer(client, organizationId, data);
}

function disabledAutomationSummary(configured: boolean, enabled: boolean): AutomationBillingSummary {
  return {
    allowance: AUTOMATION_FREE_ALLOWANCE_DOLLARS,
    cancelsAtPeriodEnd: false,
    configured,
    enabled,
    nextResetAt: null,
    planId: AUTOMATION_FREE_PLAN_ID,
    plans: AUTOMATION_PAID_PLANS.map((plan) => ({ ...plan })),
    remaining: AUTOMATION_FREE_ALLOWANCE_DOLLARS,
    scheduledPlanId: null,
    usage: 0,
  };
}

export function summarizeAutomationBillingCustomer(
  customer: Customer,
): AutomationBillingSummary {
  const balance = customer.balances[AUTOMATION_INFERENCE_FEATURE_ID];
  const plan = automationPlanFromCustomer(customer);
  const planId = plan.active ?? AUTOMATION_FREE_PLAN_ID;
  const allowance = balance?.granted ??
    AUTOMATION_PAID_PLANS.find((candidate) => candidate.id === planId)?.included ??
    AUTOMATION_FREE_ALLOWANCE_DOLLARS;
  return {
    allowance,
    cancelsAtPeriodEnd: plan.cancelsAtPeriodEnd,
    configured: true,
    enabled: true,
    nextResetAt: balance?.nextResetAt ?? null,
    planId,
    plans: AUTOMATION_PAID_PLANS.map((candidate) => ({ ...candidate })),
    remaining: Math.max(0, balance?.remaining ?? allowance),
    scheduledPlanId: plan.scheduled,
    usage: Math.max(0, balance?.usage ?? 0),
  };
}

export async function getAutomationBillingSummary(
  organizationId: string,
  data?: BillingCustomerData,
): Promise<AutomationBillingSummary> {
  if (!billingIsEnabled()) return disabledAutomationSummary(false, false);
  const client = getAutomationClientOrNull();
  if (!client) return disabledAutomationSummary(false, true);
  return summarizeAutomationBillingCustomer(
    await ensureAutomationPlan(client, organizationId, data),
  );
}

function getAutomationClientOrNull(): Autumn | null {
  const client = getAutumnClient();
  if (!client && process.env.NODE_ENV === "production") {
    throw new Error("AUTUMN_SECRET_KEY is required in production");
  }
  return client;
}

// Read-only check that Responder-funded inference may continue. It does not
// deduct anything; usage is reported after each model response.
export async function checkAutomationInferenceAllowance(
  organizationId: string,
): Promise<AutomationInferenceAccess> {
  if (!billingIsEnabled()) return { allowed: true, nextResetAt: null };
  const client = getAutomationClientOrNull();
  if (!client) return { allowed: true, nextResetAt: null };

  const check = () =>
    client.check({
      customerId: organizationId,
      featureId: AUTOMATION_INFERENCE_FEATURE_ID,
      requiredBalance: automationMinimumBalanceDollars,
    });
  // A new organization may have no Autumn customer yet (404), and an existing
  // customer may have no automation plan yet (no balance). Set up both once.
  let result = await check().catch((error: unknown) => {
    if (hasStatus(error, 404)) return null;
    throw error;
  });
  if (!result || (!result.allowed && result.balance === null)) {
    const customer = await ensureAutomationPlan(client, organizationId);
    if (customer.id === null) return { allowed: true, nextResetAt: null };
    result = await check();
  }
  return {
    allowed: result.allowed,
    nextResetAt: result.balance?.nextResetAt ?? null,
  };
}

function hasStatus(error: unknown, status: number): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    error.statusCode === status
  );
}

// Reports one model request. The usage row ID is the idempotency key, so a
// retry after an uncertain response cannot charge twice.
export async function trackAutomationInferenceUsage(input: {
  costMicros: number;
  model: string;
  organizationId: string;
  runId: string;
  usageId: string;
}): Promise<void> {
  if (!billingIsEnabled()) return;
  const client = requireAutumnClient();
  if (input.costMicros <= 0) return;
  try {
    await client.track(
      {
        customerId: input.organizationId,
        featureId: AUTOMATION_INFERENCE_FEATURE_ID,
        properties: { model: input.model, runId: input.runId },
        value: input.costMicros / 1_000_000,
      },
      { headers: { "Idempotency-Key": `automation-usage:${input.usageId}` } },
    );
  } catch (error) {
    if (!hasStatus(error, 409)) throw error;
  }
}

export async function changeAutomationPlan(
  organizationId: string,
  planId: AutomationPaidPlanId,
  successUrl: string,
  data?: BillingCustomerData,
): Promise<{ url: string | null }> {
  if (!billingIsEnabled()) throw new Error("Billing is disabled");
  const client = requireAutumnClient();
  await ensureAutomationPlan(client, organizationId, data);
  const result = await client.billing.attach({
    customerId: organizationId,
    planId,
    redirectMode: "if_required",
    successUrl,
  });
  return { url: result.paymentUrl ?? null };
}

// Paid automation plans end at the close of the billing period. The next
// allowance check then attaches the free automation plan again.
export async function cancelAutomationPlan(organizationId: string): Promise<boolean> {
  if (!billingIsEnabled()) throw new Error("Billing is disabled");
  const client = requireAutumnClient();
  const customer = await getOrCreateCustomer(client, organizationId);
  const planId = automationPlanFromCustomer(customer).active;
  if (!isAutomationPaidPlanId(planId)) return false;
  await client.billing.update({
    cancelAction: "cancel_end_of_cycle",
    customerId: organizationId,
    planId,
  });
  return true;
}
