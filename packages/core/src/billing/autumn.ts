import { randomUUID } from "node:crypto";
import { Autumn, type Customer } from "autumn-js";
import { sandboxTimeIsBilled } from "./usage-charges.js";

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

// Usage is metered against a separate plan group, so these plans change
// independently of investigation billing. The usage credit, in US dollars,
// covers Responder-funded model usage. Free, Pro, and Team also include
// machine hours for sandbox time.
export const AUTOMATION_INFERENCE_FEATURE_ID = "responder_automation_inference";
export const MACHINE_HOURS_FEATURE_ID = "responder_machine_hours";
export const AUTOMATION_FREE_PLAN_ID = "responder_plan_free";
export const AUTOMATION_PAID_PLANS = [
  { id: "responder_plan_pro", included: 100, machineHours: 50, name: "Pro", price: 100 },
  { id: "responder_plan_team", included: 200, machineHours: 500, name: "Team", price: 200 },
] as const;
export const AUTOMATION_FREE_ALLOWANCE_DOLLARS = 5;
export const AUTOMATION_FREE_MACHINE_HOURS = 2;

// Plans from before Free, Pro, and Team. Workspaces that have them keep them
// until they change plans. They have no machine hours, so where the edition
// prices sandbox time it is paid from the usage credit.
const LEGACY_AUTOMATION_PLANS = [
  { id: "responder_automations_free", name: "Free", price: 0 },
  { id: "responder_automations_100", name: "$100 / month", price: 100 },
  { id: "responder_automations_200", name: "$200 / month", price: 200 },
] as const;

const usageTrackTimeoutMs = 30_000;

// A run may start while at least one cent of the allowance remains.
const automationMinimumBalanceDollars = 0.01;
// A sandbox may start while at least a minute of machine time remains.
const minimumMachineHours = 1 / 60;

export type AutomationPaidPlanId = (typeof AUTOMATION_PAID_PLANS)[number]["id"];
export type AutomationPlanId =
  | typeof AUTOMATION_FREE_PLAN_ID
  | AutomationPaidPlanId
  | (typeof LEGACY_AUTOMATION_PLANS)[number]["id"];

const automationPlans: ReadonlyArray<{ id: AutomationPlanId; name: string; price: number }> = [
  { id: AUTOMATION_FREE_PLAN_ID, name: "Free", price: 0 },
  ...AUTOMATION_PAID_PLANS,
  ...LEGACY_AUTOMATION_PLANS,
];

function automationPlan(planId: AutomationPlanId) {
  return automationPlans.find((plan) => plan.id === planId) ?? automationPlans[0]!;
}

// Paid plans a workspace can switch to.
export function isAutomationPaidPlanId(value: unknown): value is AutomationPaidPlanId {
  return AUTOMATION_PAID_PLANS.some((plan) => plan.id === value);
}

export interface UsageBalanceSummary {
  granted: number;
  nextResetAt: number | null;
  // Usage past the granted amount is billed instead of stopping work.
  overageAllowed: boolean;
  remaining: number;
  usage: number;
}

export interface AutomationBillingSummary {
  allowance: number;
  cancelsAtPeriodEnd: boolean;
  configured: boolean;
  // Usage past the credit is billed instead of stopping work.
  creditOverageAllowed: boolean;
  enabled: boolean;
  // Null on plans that pay for sandbox time from the usage credit.
  machineHours: UsageBalanceSummary | null;
  nextResetAt: number | null;
  paid: boolean;
  // Start of the current billing period, when Autumn reports one.
  periodStart: number | null;
  planId: AutomationPlanId;
  planName: string;
  planPrice: number;
  plans: Array<{
    id: AutomationPaidPlanId;
    included: number;
    machineHours: number;
    name: string;
    price: number;
  }>;
  remaining: number;
  scheduledPlanId: AutomationPlanId | null;
  scheduledPlanName: string | null;
  usage: number;
}

export interface AutomationInferenceAccess {
  allowed: boolean;
  nextResetAt: number | null;
}

export interface WorkAllowance extends AutomationInferenceAccess {
  // The balance that stopped the work.
  exhausted: "machine_hours" | "usage_credit" | null;
  // Sandbox time is paid from the usage credit, as on plans without machine
  // hours.
  machinesUseCredit: boolean;
}

function automationPlanFromCustomer(customer: Customer): {
  active: AutomationPlanId | null;
  cancelsAtPeriodEnd: boolean;
  periodStart: number | null;
  scheduled: AutomationPlanId | null;
} {
  const find = (status: "active" | "scheduled") =>
    customer.subscriptions.find(
      (subscription) =>
        subscription.status === status &&
        automationPlans.some((plan) => plan.id === subscription.planId),
    );
  const active = find("active");
  return {
    active: (active?.planId as AutomationPlanId | undefined) ?? null,
    cancelsAtPeriodEnd: active?.canceledAt != null,
    periodStart: active?.currentPeriodStart ?? null,
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
  try {
    await client.billing.attach({
      customerId: organizationId,
      planId: AUTOMATION_FREE_PLAN_ID,
      redirectMode: "never",
    });
  } catch (error) {
    // A concurrent first run may have attached the plan already.
    const current = await getOrCreateCustomer(client, organizationId, data);
    if (automationPlanFromCustomer(current).active) return current;
    throw error;
  }
  return getOrCreateCustomer(client, organizationId, data);
}

function paidPlanSummaries(): AutomationBillingSummary["plans"] {
  return AUTOMATION_PAID_PLANS.map((plan) => ({ ...plan }));
}

function disabledAutomationSummary(configured: boolean, enabled: boolean): AutomationBillingSummary {
  return {
    allowance: AUTOMATION_FREE_ALLOWANCE_DOLLARS,
    cancelsAtPeriodEnd: false,
    configured,
    creditOverageAllowed: false,
    enabled,
    machineHours: {
      granted: AUTOMATION_FREE_MACHINE_HOURS,
      nextResetAt: null,
      overageAllowed: false,
      remaining: AUTOMATION_FREE_MACHINE_HOURS,
      usage: 0,
    },
    nextResetAt: null,
    paid: false,
    periodStart: null,
    planId: AUTOMATION_FREE_PLAN_ID,
    planName: automationPlan(AUTOMATION_FREE_PLAN_ID).name,
    planPrice: 0,
    plans: paidPlanSummaries(),
    remaining: AUTOMATION_FREE_ALLOWANCE_DOLLARS,
    scheduledPlanId: null,
    scheduledPlanName: null,
    usage: 0,
  };
}

function balanceSummary(balance: NonNullable<Customer["balances"][string]>): UsageBalanceSummary {
  return {
    granted: balance.granted,
    nextResetAt: balance.nextResetAt ?? null,
    overageAllowed: balance.overageAllowed,
    remaining: Math.max(0, balance.remaining),
    usage: Math.max(0, balance.usage),
  };
}

export function summarizeAutomationBillingCustomer(
  customer: Customer,
): AutomationBillingSummary {
  const balance = customer.balances[AUTOMATION_INFERENCE_FEATURE_ID];
  const machineHours = customer.balances[MACHINE_HOURS_FEATURE_ID];
  const plan = automationPlanFromCustomer(customer);
  const current = automationPlan(plan.active ?? AUTOMATION_FREE_PLAN_ID);
  const allowance = balance?.granted ??
    AUTOMATION_PAID_PLANS.find((candidate) => candidate.id === current.id)?.included ??
    AUTOMATION_FREE_ALLOWANCE_DOLLARS;
  return {
    allowance,
    cancelsAtPeriodEnd: plan.cancelsAtPeriodEnd,
    configured: true,
    creditOverageAllowed: balance?.overageAllowed ?? false,
    enabled: true,
    machineHours: machineHours ? balanceSummary(machineHours) : null,
    nextResetAt: balance?.nextResetAt ?? null,
    paid: current.price > 0,
    periodStart: plan.periodStart,
    planId: current.id,
    planName: current.name,
    planPrice: current.price,
    plans: paidPlanSummaries(),
    remaining: Math.max(0, balance?.remaining ?? allowance),
    scheduledPlanId: plan.scheduled,
    scheduledPlanName: plan.scheduled ? automationPlan(plan.scheduled).name : null,
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

// Read-only check that metered work may start or continue. It does not
// deduct anything; usage is reported as it is measured.
export async function checkUsageAllowance(
  organizationId: string,
  requiredDollars = automationMinimumBalanceDollars,
): Promise<AutomationInferenceAccess> {
  if (!billingIsEnabled()) return { allowed: true, nextResetAt: null };
  const client = getAutomationClientOrNull();
  if (!client) return { allowed: true, nextResetAt: null };

  const check = () =>
    client.check({
      customerId: organizationId,
      featureId: AUTOMATION_INFERENCE_FEATURE_ID,
      requiredBalance: Math.max(automationMinimumBalanceDollars, requiredDollars),
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

function balanceAllows(
  balance: NonNullable<Customer["balances"][string]>,
  required: number,
): boolean {
  return balance.unlimited || balance.overageAllowed || balance.remaining >= required;
}

// Read-only check that a run may start a sandbox. The usage credit must last
// when the run uses Responder-funded models or the plan pays for sandbox time
// from it; machine hours must last on plans that include them.
export async function checkWorkAllowance(
  organizationId: string,
  options: { responderModels: boolean },
): Promise<WorkAllowance> {
  const open: WorkAllowance = {
    allowed: true,
    exhausted: null,
    machinesUseCredit: false,
    nextResetAt: null,
  };
  if (!billingIsEnabled()) return open;
  const client = getAutomationClientOrNull();
  if (!client) return open;
  const customer = await ensureAutomationPlan(client, organizationId);
  if (customer.id === null) return open;

  const credit = customer.balances[AUTOMATION_INFERENCE_FEATURE_ID];
  const machineHours = customer.balances[MACHINE_HOURS_FEATURE_ID];
  const machinesUseCredit = !machineHours && sandboxTimeIsBilled();
  if (
    (options.responderModels || machinesUseCredit) &&
    !(credit && balanceAllows(credit, automationMinimumBalanceDollars))
  ) {
    return {
      allowed: false,
      exhausted: "usage_credit",
      machinesUseCredit,
      nextResetAt: credit?.nextResetAt ?? null,
    };
  }
  if (machineHours && !balanceAllows(machineHours, minimumMachineHours)) {
    return {
      allowed: false,
      exhausted: "machine_hours",
      machinesUseCredit,
      nextResetAt: machineHours.nextResetAt ?? null,
    };
  }
  return { ...open, machinesUseCredit };
}

const machineHoursLookupLifetimeMs = 5 * 60_000;
const machineHoursLookups = new Map<string, { expiresAt: number; value: boolean }>();

// Whether the organization's plan meters sandbox time in machine hours rather
// than paying for it from the usage credit. Throws when Autumn cannot answer,
// so the caller retries rather than charging the wrong balance.
export async function organizationUsesMachineHours(organizationId: string): Promise<boolean> {
  const cached = machineHoursLookups.get(organizationId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const customer = await getOrCreateCustomer(requireAutumnClient(), organizationId);
  if (customer.id === null) throw new Error("Autumn did not return the billing customer");
  const value = customer.balances[MACHINE_HOURS_FEATURE_ID] !== undefined;
  machineHoursLookups.set(organizationId, {
    expiresAt: Date.now() + machineHoursLookupLifetimeMs,
    value,
  });
  return value;
}

function hasStatus(error: unknown, status: number): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    error.statusCode === status
  );
}

async function trackUsage(input: {
  featureId: string;
  idempotencyKey: string;
  organizationId: string;
  properties: Record<string, string>;
  value: number;
}): Promise<void> {
  if (!billingIsEnabled()) return;
  const client = requireAutumnClient();
  if (input.value <= 0) return;
  try {
    await client.track(
      {
        customerId: input.organizationId,
        featureId: input.featureId,
        properties: input.properties,
        value: input.value,
      },
      {
        headers: { "Idempotency-Key": input.idempotencyKey },
        timeoutMs: usageTrackTimeoutMs,
      },
    );
  } catch (error) {
    if (!hasStatus(error, 409)) throw error;
  }
}

// Reports one charge against the usage credit. The idempotency key must be
// stable for the charged record, so a retry after an uncertain response
// cannot charge twice.
export async function trackUsageCharge(input: {
  chargeMicros: number;
  idempotencyKey: string;
  organizationId: string;
  properties: Record<string, string>;
}): Promise<void> {
  await trackUsage({
    featureId: AUTOMATION_INFERENCE_FEATURE_ID,
    idempotencyKey: input.idempotencyKey,
    organizationId: input.organizationId,
    properties: input.properties,
    value: input.chargeMicros / 1_000_000,
  });
}

// Reports sandbox time against the machine hours balance, with the same
// idempotency rule as usage charges.
export async function trackMachineHours(input: {
  hours: number;
  idempotencyKey: string;
  organizationId: string;
  properties: Record<string, string>;
}): Promise<void> {
  await trackUsage({
    featureId: MACHINE_HOURS_FEATURE_ID,
    idempotencyKey: input.idempotencyKey,
    organizationId: input.organizationId,
    properties: input.properties,
    value: input.hours,
  });
}

// Reports one model request. The usage row ID is the idempotency key.
export async function trackAutomationInferenceUsage(input: {
  costMicros: number;
  model: string;
  organizationId: string;
  runId: string;
  usageId: string;
}): Promise<void> {
  await trackUsageCharge({
    chargeMicros: input.costMicros,
    idempotencyKey: `automation-usage:${input.usageId}`,
    organizationId: input.organizationId,
    properties: { model: input.model, runId: input.runId },
  });
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
  return updateAutomationPlanCancellation(organizationId, "cancel_end_of_cycle");
}

// Keeps the current paid plan after a cancellation was scheduled.
export async function resumeAutomationPlan(organizationId: string): Promise<boolean> {
  return updateAutomationPlanCancellation(organizationId, "uncancel");
}

async function updateAutomationPlanCancellation(
  organizationId: string,
  cancelAction: "cancel_end_of_cycle" | "uncancel",
): Promise<boolean> {
  if (!billingIsEnabled()) throw new Error("Billing is disabled");
  const client = requireAutumnClient();
  const customer = await getOrCreateCustomer(client, organizationId);
  const planId = automationPlanFromCustomer(customer).active;
  if (!planId || automationPlan(planId).price === 0) return false;
  await client.billing.update({ cancelAction, customerId: organizationId, planId });
  return true;
}
