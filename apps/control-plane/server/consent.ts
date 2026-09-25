import { c15tInstance, type C15TInstance } from "@c15t/backend";
import { drizzleAdapter } from "@c15t/backend/db/adapters/drizzle";
import { getDatabase } from "../../../packages/core/src/db/client.js";
import { configuredAuthTrustedOrigins } from "./auth.js";
import { consentPolicyPacks, withViewerLocation } from "./consent-policy.js";

export const consentBasePath = "/api/c15t";
export const consentTablePrefix = "c15t_";

let consentBackend: C15TInstance | undefined;

function getConsentBackend(): C15TInstance {
  consentBackend ??= c15tInstance({
    adapter: drizzleAdapter({ db: getDatabase(), provider: "postgresql" }),
    appName: "responder",
    basePath: consentBasePath,
    ipAddress: { ipAddressHeaders: ["x-responder-client-ip"], masking: true },
    logger: { level: "warn" },
    openapi: { enabled: false },
    policyPacks: consentPolicyPacks,
    tablePrefix: consentTablePrefix,
    trustedOrigins: configuredAuthTrustedOrigins(),
  });
  return consentBackend;
}

/** Serves the c15t consent API, which records consent in Postgres. */
export function handleConsentRequest(request: Request): Promise<Response> {
  return getConsentBackend().handler(withViewerLocation(request));
}
