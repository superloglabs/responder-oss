import { z } from "zod";

// The GitHub Apps this instance uses. The default app, from the GITHUB_APP_*
// variables, is the one new connections install. GITHUB_ADDITIONAL_APPS lists
// apps whose installations existing connections still use, as JSON:
// [{ "appId": "…", "privateKey": "…", "webhookSecret": "…" }].

export interface GitHubApp {
  appId: string;
  privateKey: string;
  webhookSecret?: string;
}

const additionalAppsSchema = z.array(z.object({
  appId: z.union([z.string().min(1), z.number().int().positive()]).transform(String),
  privateKey: z.string().min(1),
  webhookSecret: z.string().min(1).optional(),
}));

function pem(value: string): string {
  return value.replace(/\\n/g, "\n");
}

export function githubAdditionalApps(environment: NodeJS.ProcessEnv = process.env): GitHubApp[] {
  const configured = environment.GITHUB_ADDITIONAL_APPS?.trim();
  if (!configured) return [];
  try {
    return additionalAppsSchema.parse(JSON.parse(configured)).map((app) => ({
      ...app,
      privateKey: pem(app.privateKey),
    }));
  } catch {
    throw new Error("GITHUB_ADDITIONAL_APPS must be a JSON array of { appId, privateKey, webhookSecret }");
  }
}

// Every configured app, the default app first.
export function githubApps(environment: NodeJS.ProcessEnv = process.env): GitHubApp[] {
  const appId = environment.GITHUB_APP_ID;
  const privateKey = environment.GITHUB_APP_PRIVATE_KEY;
  const webhookSecret = environment.GITHUB_WEBHOOK_SECRET;
  const defaultApp: GitHubApp[] = appId && privateKey
    ? [{ appId, privateKey: pem(privateKey), ...(webhookSecret ? { webhookSecret } : {}) }]
    : [];
  return [...defaultApp, ...githubAdditionalApps(environment)];
}

// Every secret a GitHub webhook may be signed with, the default app's first.
export function githubWebhookSecrets(environment: NodeJS.ProcessEnv = process.env): string[] {
  return [
    environment.GITHUB_WEBHOOK_SECRET,
    ...githubAdditionalApps(environment).map((app) => app.webhookSecret),
  ].filter((secret): secret is string => Boolean(secret));
}
