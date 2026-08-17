export function controlPlaneBaseUrl(): string {
  return process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
}

export function integrationCallbackUrl(
  provider:
    | "clickstack"
    | "custom_mcp"
    | "datadog"
    | "github"
    | "linear"
    | "sentry"
    | "slack",
): string {
  const callbackBaseUrl =
    process.env.RESPONDER_PUBLIC_URL ?? controlPlaneBaseUrl();
  return `${callbackBaseUrl}/api/integrations/${provider}/callback`;
}

export function settingsRedirect(
  returnTo: string,
  provider: string,
  status: "connected" | "error" | "finishing",
  reason?: string,
): string {
  const path = returnTo.startsWith("/") && !returnTo.startsWith("//")
    ? returnTo
    : "/settings";
  const url = new URL(path, controlPlaneBaseUrl());
  url.searchParams.set("integration", provider);
  url.searchParams.set("status", status);
  if (reason) url.searchParams.set("reason", reason);
  return url.toString();
}
