import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import { type Cell, type CellDirectory, cellDirectory } from "../../../../packages/core/src/cells.js";
import {
  getPendingIntegrationConnectionState,
  listConnectedIntegrationAccounts,
} from "../../../../packages/core/src/db/integrations.js";
import { getActiveTenant } from "../tenant.js";

// A GitHub App has one setup URL, where GitHub sends people after they install
// or change the app. While the old Superlog product's app points it here
// (ADR 0012), a callback whose state this application created continues here,
// and any other is redirected, with its query unchanged, to the old product's
// address in LEGACY_GITHUB_SETUP_URL.
//
// GitHub leaves the state out when someone changes an installation on GitHub.
// Such a callback stays in the application when the signed-in user has a
// GitHub connection pending, or when their active workspace holds the
// installation. Otherwise it goes to the cell the browser last used, or, from
// that cell or without one, to the old product. Where it goes depends only on
// the browser's own session and cookies, never on who else holds the
// installation.

const applicationStatePrefix = "responder-v1.";

export type LegacyGitHubSetupDependencies = {
  directory: () => CellDirectory | null;
  // Whether the signed-in user here has a GitHub connection pending, or an
  // active workspace that holds the installation.
  keepsHere: (headers: Headers, installationId: number | null) => Promise<boolean>;
  setupUrl: () => string | null;
};

// Names the cell a signed-in visitor last used. The browser sets it.
const cellCookieName = "responder_cell";

export function legacyGitHubSetupUrl(environment: NodeJS.ProcessEnv = process.env): string | null {
  const configured = environment.LEGACY_GITHUB_SETUP_URL?.trim();
  if (!configured) return null;
  const parsed = z.url({ protocol: /^https$/u }).safeParse(configured);
  if (!parsed.success) throw new Error("LEGACY_GITHUB_SETUP_URL must be an HTTPS URL");
  return parsed.data;
}

export async function keepsGitHubSetupHere(headers: Headers, installationId: number | null): Promise<boolean> {
  const tenant = await getActiveTenant(headers);
  if (tenant.ok === false) return false;
  const owner = { organizationId: tenant.organizationId, userId: tenant.user.id };
  if (await getPendingIntegrationConnectionState("github", owner)) return true;
  if (installationId === null) return false;
  const accounts = await listConnectedIntegrationAccounts(tenant.organizationId, "github");
  return accounts.some((account) => account.externalAccountId === String(installationId));
}

const defaultDependencies: LegacyGitHubSetupDependencies = {
  directory: () => cellDirectory(),
  keepsHere: keepsGitHubSetupHere,
  setupUrl: () => legacyGitHubSetupUrl(),
};

function rememberedOtherCell(value: string | undefined, directory: CellDirectory | null): Cell | null {
  if (!value || !directory || value === directory.current) return null;
  return directory.cells.find((cell) => cell.id === value) ?? null;
}

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
      const installationId = z.coerce.number().int().positive()
        .safeParse(requestUrl.searchParams.get("installation_id"));
      let cell: Cell | null;
      try {
        if (await dependencies.keepsHere(
          context.req.raw.headers,
          installationId.success ? installationId.data : null,
        )) {
          return next();
        }
        cell = rememberedOtherCell(getCookie(context, cellCookieName), dependencies.directory());
      } catch (error) {
        // The application answers when it cannot tell whose callback this is.
        console.error(JSON.stringify({ errorMessage: errorMessage(error), event: "legacy_github_setup_lookup_failed" }));
        return next();
      }
      if (cell) {
        console.info(JSON.stringify({ cell: cell.id, event: "github_setup_callback_forwarded" }));
        return context.redirect(`${cell.url}${requestUrl.pathname}${requestUrl.search}`, 302);
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
