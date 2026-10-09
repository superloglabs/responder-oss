import {
  cancelAutomationPlan,
  changeAutomationPlan,
  resumeAutomationPlan,
  createBillingPortal,
  createPayAsYouGoCheckout,
  getAutomationBillingSummary,
  getBillingSummary,
  isAutomationPaidPlanId,
} from "../../../../packages/core/src/billing/autumn.js";
import {
  organizationUsesUsageBilling,
  usagePeriodStart,
} from "../../../../packages/core/src/billing/usage-billing.js";
import { getUsageBreakdown } from "../../../../packages/core/src/db/usage-breakdown.js";
import {
  getUsageHistory,
  parseUsageHistoryDays,
} from "../../../../packages/core/src/db/usage-history.js";
import { sandboxTimeIsBilled } from "../../../../packages/core/src/billing/usage-charges.js";
import { organizationHasCapability } from "../../../../packages/core/src/db/organization-capabilities.js";
import { Hono } from "hono";
import { createRateLimiter } from "../rate-limit.js";
import { getActiveTenant, type ActiveTenantResult } from "../tenant.js";

type ActiveTenant = Extract<ActiveTenantResult, { ok: true }>;

// The app reads billing on page loads and a one-minute banner refresh.
export const BILLING_REQUESTS_PER_MINUTE = 30;
// Every summary costs several Autumn calls. Requests for one workspace within
// this window share one load.
export const BILLING_SUMMARY_TTL_MS = 10_000;

function appUrl(requestUrl: string, path: string): string {
  const configuredOrigin = process.env.BETTER_AUTH_URL;
  const origin = configuredOrigin
    ? new URL(configuredOrigin).origin
    : new URL(requestUrl).origin;
  return new URL(path, origin).toString();
}

// Onboarding continues at its next step after checkout. Other plan changes
// return to the billing page.
function planChangeReturnPath(value: unknown): string {
  return typeof value === "string" && /^\/onboarding\/[a-z]+$/.test(value)
    ? value
    : "/settings/billing?status=automation-plan";
}

function customerData(user: { email: string; name: string }) {
  return { email: user.email, name: user.name };
}

async function loadBillingSummary(tenant: ActiveTenant) {
  const data = customerData(tenant.user);
  const [usageBased, automationsEnabled] = await Promise.all([
    organizationUsesUsageBilling(tenant.organizationId),
    organizationHasCapability(tenant.organizationId, "automations"),
  ]);
  const [summary, automations] = await Promise.all([
    getBillingSummary(tenant.organizationId, data),
    usageBased
      ? getAutomationBillingSummary(tenant.organizationId, data)
      : automationsEnabled
        // Investigation billing stays available if automation billing fails.
        ? getAutomationBillingSummary(tenant.organizationId, data)
          .catch((error: unknown) => {
            console.error("Unable to load automation billing summary", error);
            return null;
          })
        : null,
  ]);
  // The page still shows the allowance if the breakdown cannot load.
  const breakdown = automations
    ? await getUsageBreakdown(tenant.organizationId, usagePeriodStart(automations))
      .catch((error: unknown) => {
        console.error("Unable to load usage breakdown", error);
        return null;
      })
    : null;
  return {
    ...summary,
    automations: automations && {
      ...automations,
      breakdown: breakdown && {
        inference: breakdown.inferenceMicros / 1_000_000,
        sandbox: breakdown.sandboxMicros / 1_000_000,
      },
      // Plans with machine hours meter sandbox time there instead.
      sandboxTimeBilled: sandboxTimeIsBilled() && automations.machineHours === null,
    },
    usageBased,
  };
}

type BillingSummaryResponse = Awaited<ReturnType<typeof loadBillingSummary>>;

// A load in progress has no expiry. The window starts when it finishes.
const summaries = new Map<
  string,
  { expiresAt: number; summary: Promise<BillingSummaryResponse> }
>();

function cachedBillingSummary(tenant: ActiveTenant): Promise<BillingSummaryResponse> {
  const now = Date.now();
  for (const [organizationId, entry] of summaries) {
    if (entry.expiresAt <= now) summaries.delete(organizationId);
  }
  const cached = summaries.get(tenant.organizationId);
  if (cached) return cached.summary;

  const summary = loadBillingSummary(tenant);
  const entry = { expiresAt: Number.POSITIVE_INFINITY, summary };
  summaries.set(tenant.organizationId, entry);
  summary.then(
    () => {
      entry.expiresAt = Date.now() + BILLING_SUMMARY_TTL_MS;
    },
    () => {
      // A failed load is retried on the next request.
      if (summaries.get(tenant.organizationId) === entry) {
        summaries.delete(tenant.organizationId);
      }
    },
  );
  return summary;
}

const billingRequests = createRateLimiter({
  limit: BILLING_REQUESTS_PER_MINUTE,
  windowMs: 60_000,
});

export const billingRoutes = new Hono<{ Variables: { tenant: ActiveTenant } }>()
  .use("*", async (context, next) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }
    const limit = billingRequests.take(tenant.user.id);
    if (!limit.allowed) {
      // One line per member and window, however many requests are refused.
      if (limit.firstRefusal) {
        console.warn(
          JSON.stringify({
            event: "billing_rate_limited",
            organizationId: tenant.organizationId,
            pathname: context.req.path,
            userId: tenant.user.id,
          }),
        );
      }
      context.header("retry-after", String(limit.retryAfterSeconds));
      return context.json({ error: "Too many requests" }, 429);
    }
    context.set("tenant", tenant);
    await next();
  })
  .get("/", async (context) => {
    try {
      return context.json(await cachedBillingSummary(context.get("tenant")));
    } catch (error) {
      console.error("Unable to load billing summary", error);
      return context.json({ error: "Unable to load billing" }, 502);
    }
  })
  .get("/usage", async (context) => {
    const tenant = context.get("tenant");
    const [automationsEnabled, usageBased] = await Promise.all([
      organizationHasCapability(tenant.organizationId, "automations"),
      organizationUsesUsageBilling(tenant.organizationId),
    ]);
    if (!automationsEnabled && !usageBased) {
      return context.json({ error: "Not found" }, 404);
    }
    try {
      return context.json(await getUsageHistory({
        days: parseUsageHistoryDays(context.req.query("days")),
        organizationId: tenant.organizationId,
      }));
    } catch (error) {
      console.error("Unable to load usage history", error);
      return context.json({ error: "Unable to load usage" }, 502);
    }
  })
  .post("/checkout", async (context) => {
    const tenant = context.get("tenant");

    try {
      const url = await createPayAsYouGoCheckout(
        tenant.organizationId,
        appUrl(context.req.url, "/settings/billing?status=success"),
        customerData(tenant.user),
      );
      // The page reads billing again when the person returns from checkout.
      summaries.delete(tenant.organizationId);
      return context.json({ url });
    } catch (error) {
      console.error("Unable to create billing checkout", error);
      return context.json({ error: "Unable to start billing checkout" }, 502);
    }
  })
  .post("/automations/plan", async (context) => {
    const tenant = context.get("tenant");
    const [automationsEnabled, usageBased] = await Promise.all([
      organizationHasCapability(tenant.organizationId, "automations"),
      organizationUsesUsageBilling(tenant.organizationId),
    ]);
    if (!automationsEnabled && !usageBased) {
      return context.json({ error: "Not found" }, 404);
    }
    const body = (await context.req.json().catch(() => null)) as
      | { planId?: unknown; returnTo?: unknown }
      | null;
    const planId = body?.planId;
    if (planId !== "free" && planId !== "resume" && !isAutomationPaidPlanId(planId)) {
      return context.json({ error: "Unknown automation plan" }, 400);
    }

    try {
      if (planId === "free" || planId === "resume") {
        await (planId === "free" ? cancelAutomationPlan : resumeAutomationPlan)(
          tenant.organizationId,
        );
        summaries.delete(tenant.organizationId);
        return context.json({ url: null });
      }
      const result = await changeAutomationPlan(
        tenant.organizationId,
        planId,
        appUrl(context.req.url, planChangeReturnPath(body?.returnTo)),
        customerData(tenant.user),
      );
      summaries.delete(tenant.organizationId);
      return context.json(result);
    } catch (error) {
      console.error("Unable to change automation plan", error);
      return context.json({ error: "Unable to change the automation plan" }, 502);
    }
  })
  .post("/portal", async (context) => {
    const tenant = context.get("tenant");

    try {
      const url = await createBillingPortal(
        tenant.organizationId,
        appUrl(context.req.url, "/settings/billing"),
      );
      summaries.delete(tenant.organizationId);
      return context.json({ url });
    } catch (error) {
      console.error("Unable to create billing portal", error);
      return context.json({ error: "Unable to open billing portal" }, 502);
    }
  });
