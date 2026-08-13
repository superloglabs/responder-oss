import {
  createBillingPortal,
  createPayAsYouGoCheckout,
  getBillingSummary,
} from "../../../../packages/core/src/billing/autumn.js";
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
      return context.json(
        await getBillingSummary(
          tenant.organizationId,
          customerData(tenant.user),
        ),
      );
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
