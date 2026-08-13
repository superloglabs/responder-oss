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
    return { allowed: true, configured: false, nextResetAt: null };
  }
  const client = getAutumnClient();
  if (!client) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("AUTUMN_SECRET_KEY is required in production");
    }
    return { allowed: true, configured: false, nextResetAt: null };
  }

  const customer = await getOrCreateCustomer(client, organizationId);
  if (customer.id === null) {
    // Autumn's SDK fails open during a provider outage. Preserve that behavior so
    // incident response is not taken down by the billing system.
    return { allowed: true, configured: true, nextResetAt: null };
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
