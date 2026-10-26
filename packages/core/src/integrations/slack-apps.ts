import { z } from "zod";

// The Slack apps this instance accepts. The default app, from the SLACK_*
// variables, is the one new connections install. SLACK_ADDITIONAL_APPS lists
// apps that existing connections still use, as JSON:
// [{ "appId": "A…", "signingSecret": "…" }].

const additionalAppsSchema = z.array(z.object({
  appId: z.string().min(1),
  signingSecret: z.string().min(1),
}));

export function slackAdditionalApps(
  environment: NodeJS.ProcessEnv = process.env,
): Array<z.infer<typeof additionalAppsSchema>[number]> {
  const configured = environment.SLACK_ADDITIONAL_APPS?.trim();
  if (!configured) return [];
  try {
    return additionalAppsSchema.parse(JSON.parse(configured));
  } catch {
    throw new Error("SLACK_ADDITIONAL_APPS must be a JSON array of { appId, signingSecret }");
  }
}

// Every signing secret a Slack request may be signed with, the default app's
// first.
export function slackSigningSecrets(environment: NodeJS.ProcessEnv = process.env): string[] {
  return [
    environment.SLACK_SIGNING_SECRET,
    ...slackAdditionalApps(environment).map((app) => app.signingSecret),
  ].filter((secret): secret is string => Boolean(secret));
}
