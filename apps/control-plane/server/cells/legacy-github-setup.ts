import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import { getPendingIntegrationConnectionState } from "../../../../packages/core/src/db/integrations.js";
import { getActiveTenant } from "../tenant.js";
import {
  findActiveHolder,
  type TenantHolderDependencies,
  tenantHolderDependencies,
} from "./legacy-webhook-forwarder.js";

// A GitHub App has one setup URL, where GitHub sends people after they install
// or change the app. While the old Superlog product's app points it here
// (ADR 0012), a callback whose state this application created continues here,
// and any other is redirected, with its query unchanged, to the old product's
// address in LEGACY_GITHUB_SETUP_URL.
//
// GitHub leaves the state out when someone changes an installation on GitHub.
// Such a callback stays in the application when the signed-in user has a
// GitHub connection pending, or when a workspace that is not paused holds the
// installation, or when a cell that might hold it cannot be asked. Otherwise
// it goes to the old product.

const applicationStatePrefix = "responder-v1.";

export type LegacyGitHubSetupDependencies = TenantHolderDependencies & {
  hasPendingFlow: (headers: Headers) => Promise<boolean>;
  setupUrl: () => string | null;
};

export function legacyGitHubSetupUrl(environment: NodeJS.ProcessEnv = process.env): string | null {
  const configured = environment.LEGACY_GITHUB_SETUP_URL?.trim();
  if (!configured) return null;
  const parsed = z.url({ protocol: /^https$/u }).safeParse(configured);
  if (!parsed.success) throw new Error("LEGACY_GITHUB_SETUP_URL must be an HTTPS URL");
  return parsed.data;
}

async function hasPendingGitHubFlow(headers: Headers): Promise<boolean> {
  const tenant = await getActiveTenant(headers);
  if (tenant.ok === false) return false;
  const pending = await getPendingIntegrationConnectionState("github", {
    organizationId: tenant.organizationId,
    userId: tenant.user.id,
  });
  return pending !== null;
}

const defaultDependencies: LegacyGitHubSetupDependencies = {
  ...tenantHolderDependencies,
  hasPendingFlow: hasPendingGitHubFlow,
  setupUrl: () => legacyGitHubSetupUrl(),
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function legacyGitHubSetupRedirect(
  dependencies: LegacyGitHubSetupDependencies = defaultDependencies,
): MiddlewareHandler {
  return async function legacyGitHubSetupRedirect(context, next) {
    if (context.req.method !== "GET") return next();
    const setupUrl = dependencies.setupUrl();
    if (!setupUrl) return next();
    const requestUrl = new URL(context.req.url);
    const state = requestUrl.searchParams.get("state");
    if (state?.startsWith(applicationStatePrefix)) return next();

    if (!state) {
      try {
        if (await dependencies.hasPendingFlow(context.req.raw.headers)) return next();
        const installationId = z.coerce.number().int().positive()
          .safeParse(requestUrl.searchParams.get("installation_id"));
        if (installationId.success) {
          const holder = await findActiveHolder({ key: String(installationId.data), provider: "github" }, dependencies);
          // A cell that could not be asked may hold it, so the application
          // answers rather than sending its user to the old product.
          if (holder === "here" || holder === "unknown") return next();
          if (holder) {
            console.info(JSON.stringify({ cell: holder.id, event: "github_setup_callback_forwarded" }));
            return context.redirect(`${holder.url}${requestUrl.pathname}${requestUrl.search}`, 302);
          }
        }
      } catch (error) {
        // The application answers when it cannot tell whose callback this is.
        console.error(JSON.stringify({ errorMessage: errorMessage(error), event: "legacy_github_setup_lookup_failed" }));
        return next();
      }
    }

    const target = new URL(setupUrl);
    target.search = requestUrl.search;
    console.info(JSON.stringify({
      event: "legacy_github_setup_redirected",
      reason: state ? "other_state" : "no_state",
    }));
    return context.redirect(target.toString(), 302);
  };
}
