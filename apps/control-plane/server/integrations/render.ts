import { Hono } from "hono";
import { z } from "zod";
import { captureAnalyticsEvent } from "@responder/core/analytics";
import { encryptCredentials } from "../../../../packages/core/src/credentials/encryption.js";
import { upsertIntegrationAccount } from "../../../../packages/core/src/db/integrations.js";
import {
  RenderApiError,
  renderExternalAccountId,
  renderUser,
  renderWorkspaces,
} from "../../../../packages/core/src/integrations/render.js";
import { getActiveTenant } from "../tenant.js";
import { settingsRedirect } from "./urls.js";

// Connects Render with an API key a person pastes. Render has no OAuth for
// other apps, so there is no consent screen: Superlog checks the key by
// listing the workspaces it reaches and stores it encrypted. The key is
// used only to read workspaces, services, and logs, and is never logged or
// returned.

export const renderSetupPath = "/telemetry/setup/render";

export type RenderConnectionDependencies = {
  capture: typeof captureAnalyticsEvent;
  encrypt: (credentials: Record<string, unknown>) => string;
  save: typeof upsertIntegrationAccount;
  tenant: typeof getActiveTenant;
  user: typeof renderUser;
  workspaces: typeof renderWorkspaces;
};

const defaultDependencies: RenderConnectionDependencies = {
  capture: captureAnalyticsEvent,
  encrypt: (credentials) => encryptCredentials(credentials),
  save: upsertIntegrationAccount,
  tenant: getActiveTenant,
  user: renderUser,
  workspaces: renderWorkspaces,
};

const connectionSchema = z.object({
  apiKey: z.string().trim().min(1).max(512),
  returnTo: z.string().max(2_048).optional(),
});

function withAccountId(url: string, accountId: string): string {
  const redirect = new URL(url);
  redirect.searchParams.set("integration_account_id", accountId);
  return redirect.toString();
}

export function createRenderConnectionRoutes(dependencies: RenderConnectionDependencies = defaultDependencies) {
  return new Hono().post("/connect", async (context) => {
    const tenant = await dependencies.tenant(context.req.raw.headers);
    if (tenant.ok === false) return context.json({ error: tenant.error }, tenant.status);
    const parsed = connectionSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ error: "Paste a Render API key" }, 400);
    const { apiKey } = parsed.data;

    let workspaces: Awaited<ReturnType<typeof renderWorkspaces>>;
    try {
      workspaces = await dependencies.workspaces({ apiKey });
    } catch (error) {
      if (error instanceof RenderApiError && error.kind === "unauthorized") {
        return context.json({ error: "Render rejected this API key. Create one in Render's Account settings, under API Keys." }, 401);
      }
      console.error(JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        event: "render_connect_failed",
        organizationId: tenant.organizationId,
      }));
      return context.json({ error: "Superlog could not reach Render. Try again in a moment." }, 502);
    }
    if (workspaces.length === 0) {
      return context.json({ error: "This API key reaches no Render workspaces." }, 400);
    }
    // The key's user names the connection; without it, its workspaces do.
    const user = await dependencies.user({ apiKey }).catch(() => null);
    const names = workspaces.map((workspace) => workspace.name);
    const accountId = await dependencies.save({
      credentialKeyVersion: 1,
      displayName: user?.email ?? user?.name ?? (names.length > 2 ? `${names.slice(0, 2).join(", ")} and ${names.length - 2} more` : names.join(", ")),
      encryptedCredentials: dependencies.encrypt({ apiKey }),
      externalAccountId: renderExternalAccountId({ apiKey, email: user?.email ?? null }),
      metadata: { workspaces: workspaces.slice(0, 50) },
      organizationId: tenant.organizationId,
      provider: "render",
    });
    await dependencies.capture({
      distinctId: tenant.user.id,
      event: "integration connected",
      organizationId: tenant.organizationId,
      properties: { integration_account_id: accountId, provider: "render" },
    });
    console.info(JSON.stringify({
      accountId,
      event: "render_connected",
      organizationId: tenant.organizationId,
      workspaces: workspaces.length,
    }));
    return context.json({
      accountId,
      redirectUrl: withAccountId(settingsRedirect(parsed.data.returnTo ?? renderSetupPath, "render", "connected"), accountId),
    });
  });
}

export const renderConnectionRoutes = createRenderConnectionRoutes();
