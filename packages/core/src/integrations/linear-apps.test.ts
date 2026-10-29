import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { linearWebhookApp } from "./linear-agent.js";
import { linearAdditionalApps, linearAppForConnection, linearApps } from "./linear-apps.js";

const environment = {
  LINEAR_ADDITIONAL_APPS: JSON.stringify([
    { clientId: "earlier-client", clientSecret: "earlier-secret", webhookSecret: "earlier-webhook" },
  ]),
  LINEAR_CLIENT_ID: "current-client",
  LINEAR_CLIENT_SECRET: "current-secret",
  LINEAR_WEBHOOK_SECRET: "current-webhook",
} as NodeJS.ProcessEnv;

describe("Linear apps", () => {
  it("lists the default app first, then the additional apps", () => {
    expect(linearApps(environment).map((app) => app.clientId)).toEqual(["current-client", "earlier-client"]);
  });

  it("rejects malformed additional apps", () => {
    expect(() => linearAdditionalApps({ LINEAR_ADDITIONAL_APPS: "[{\"clientId\":\"x\"}]" } as NodeJS.ProcessEnv))
      .toThrow("LINEAR_ADDITIONAL_APPS must be a JSON array of { clientId, clientSecret, webhookSecret }");
  });

  it("uses the app a connection records, and the default app when it records none", () => {
    expect(linearAppForConnection("earlier-client", environment).clientSecret).toBe("earlier-secret");
    expect(linearAppForConnection(undefined, environment).clientSecret).toBe("current-secret");
    expect(() => linearAppForConnection("unknown-client", environment))
      .toThrow("Linear app unknown-client is not configured");
  });

  it("names the app whose webhook secret signed a delivery", () => {
    const now = Date.parse("2026-10-29T12:00:00Z");
    const body = JSON.stringify({ type: "AgentSessionEvent", webhookTimestamp: now });
    const signed = (secret: string) => createHmac("sha256", secret).update(body).digest("hex");

    expect(linearWebhookApp({ body, now, signature: signed("earlier-webhook") }, environment)?.clientId)
      .toBe("earlier-client");
    expect(linearWebhookApp({ body, now, signature: signed("current-webhook") }, environment)?.clientId)
      .toBe("current-client");
    expect(linearWebhookApp({ body, now, signature: signed("other") }, environment)).toBeNull();
  });
});
