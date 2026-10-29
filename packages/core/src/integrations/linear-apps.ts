import { z } from "zod";

// The Linear OAuth apps this instance uses. The default app, from the
// LINEAR_CLIENT_ID, LINEAR_CLIENT_SECRET, and LINEAR_WEBHOOK_SECRET variables,
// is the one new connections authorize. LINEAR_ADDITIONAL_APPS lists apps that
// existing connections still use, as JSON:
// [{ "clientId": "…", "clientSecret": "…", "webhookSecret": "…" }].
//
// A connection records its app's client ID in `metadata.clientId`. One that
// records none belongs to the default app.
//
// Connections made before apps were recorded carry no client ID, so they
// follow whatever LINEAR_CLIENT_ID names. Before LINEAR_CLIENT_ID changes,
// record the current client ID in every Linear connection's metadata
// (ADR 0012); otherwise their tokens are refreshed with the new app and fail,
// and their agent sessions are no longer answered.

export interface LinearApp {
  clientId: string;
  clientSecret: string;
  webhookSecret?: string;
}

const additionalAppsSchema = z.array(z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  webhookSecret: z.string().min(1).optional(),
}));

export function linearAdditionalApps(environment: NodeJS.ProcessEnv = process.env): LinearApp[] {
  const configured = environment.LINEAR_ADDITIONAL_APPS?.trim();
  if (!configured) return [];
  try {
    return additionalAppsSchema.parse(JSON.parse(configured));
  } catch {
    throw new Error("LINEAR_ADDITIONAL_APPS must be a JSON array of { clientId, clientSecret, webhookSecret }");
  }
}

export function linearDefaultApp(environment: NodeJS.ProcessEnv = process.env): LinearApp | null {
  const clientId = environment.LINEAR_CLIENT_ID;
  const clientSecret = environment.LINEAR_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const webhookSecret = environment.LINEAR_WEBHOOK_SECRET;
  return { clientId, clientSecret, ...(webhookSecret ? { webhookSecret } : {}) };
}

// Every configured app, the default app first.
export function linearApps(environment: NodeJS.ProcessEnv = process.env): LinearApp[] {
  const defaultApp = linearDefaultApp(environment);
  return [...(defaultApp ? [defaultApp] : []), ...linearAdditionalApps(environment)];
}

// The app a connection was authorized through: the one its recorded client ID
// names, or the default app when it records none.
export function linearAppForConnection(
  clientId: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): LinearApp {
  if (typeof clientId === "string" && clientId) {
    const app = linearApps(environment).find((candidate) => candidate.clientId === clientId);
    if (!app) throw new Error(`Linear app ${clientId} is not configured`);
    return app;
  }
  // An unrecorded connection is assumed to belong to the default app; see
  // the note above before changing it.
  const defaultApp = linearDefaultApp(environment);
  if (!defaultApp) throw new Error("Linear application credentials are not configured");
  return defaultApp;
}
