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
import { sandboxTimeIsBilled } from "../../../../packages/core/src/billing/usage-charges.js";
import { organizationHasCapability } from "../../../../packages/core/src/db/organization-capabilities.js";
import { Hono } from "hono";
import { getActiveTenant } from "../tenant.js";

function appUrl(requestUrl: string, path: string): string {
  const configuredOrigin = process.env.BETTER_AUTH_URL;
  const origin = configuredOrigin
    ? new URL(configuredOrigin).origin
    : new URL(requestUrl).origin;
  return new URL(path, origin).toString();
}

function customerData(user: { email: string; name: string }) {
  return { email: user.email, name: user.name };
}

export const billingRoutes = new Hono()
  .get("/", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }

    try {
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
      return context.json({
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
      });
    } catch (error) {
      console.error("Unable to load billing summary", error);
      return context.json({ error: "Unable to load billing" }, 502);
    }
  })
  .post("/checkout", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }

    try {
      const url = await createPayAsYouGoCheckout(
        tenant.organizationId,
        appUrl(context.req.url, "/settings/billing?status=success"),
        customerData(tenant.user),
      );
      return context.json({ url });
    } catch (error) {
      console.error("Unable to create billing checkout", error);
      return context.json({ error: "Unable to start billing checkout" }, 502);
    }
  })
  .post("/automations/plan", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }
    const [automationsEnabled, usageBased] = await Promise.all([
      organizationHasCapability(tenant.organizationId, "automations"),
      organizationUsesUsageBilling(tenant.organizationId),
    ]);
    if (!automationsEnabled && !usageBased) {
      return context.json({ error: "Not found" }, 404);
    }
    const body = (await context.req.json().catch(() => null)) as
      | { planId?: unknown }
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
        return context.json({ url: null });
      }
      return context.json(
        await changeAutomationPlan(
          tenant.organizationId,
          planId,
          appUrl(context.req.url, "/settings/billing?status=automation-plan"),
          customerData(tenant.user),
        ),
      );
    } catch (error) {
      console.error("Unable to change automation plan", error);
      return context.json({ error: "Unable to change the automation plan" }, 502);
    }
  })
  .post("/portal", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }

    try {
      const url = await createBillingPortal(
        tenant.organizationId,
        appUrl(context.req.url, "/settings/billing"),
      );
      return context.json({ url });
    } catch (error) {
      console.error("Unable to create billing portal", error);
      return context.json({ error: "Unable to open billing portal" }, 502);
    }
  });
