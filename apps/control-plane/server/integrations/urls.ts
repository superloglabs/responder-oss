export function controlPlaneBaseUrl(): string {
  return process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
}

export function integrationCallbackUrl(
  provider:
    | "axiom"
    | "clickstack"
    | "custom_mcp"
    | "dash0"
    | "datadog"
    | "github"
    | "linear"
    | "posthog"
    | "sentry"
    | "slack"
    | "supabase"
    | "vercel",
): string {
  const callbackBaseUrl =
    process.env.RESPONDER_PUBLIC_URL ?? controlPlaneBaseUrl();
  return `${callbackBaseUrl}/api/integrations/${provider}/callback`;
}

export function dash0WebhookUrl(integrationAccountId: string): string {
  const callbackBaseUrl =
    process.env.RESPONDER_PUBLIC_URL ?? controlPlaneBaseUrl();
  return new URL(
    `/api/webhooks/dash0/${encodeURIComponent(integrationAccountId)}`,
    callbackBaseUrl,
  ).toString();
}

export function settingsRedirect(
  returnTo: string,
  provider: string,
  status: "connected" | "error" | "finishing" | "select_project",
  reason?: string,
): string {
  const baseUrl = new URL(controlPlaneBaseUrl());
  const path = returnTo.startsWith("/") && !returnTo.startsWith("//")
    ? returnTo
    : "/settings";
  const candidate = new URL(path, baseUrl);
  const url = candidate.origin === baseUrl.origin
    ? candidate
    : new URL("/settings", baseUrl);
  url.searchParams.set("integration", provider);
  url.searchParams.set("status", status);
  if (reason) url.searchParams.set("reason", reason);
  return url.toString();
}
