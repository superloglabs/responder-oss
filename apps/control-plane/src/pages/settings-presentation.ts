export function integrationActionUrl(integration: {
  configurationUrl: string | null;
  connectUrl: string | null;
  state: "available" | "coming_soon" | "connected" | "setup_required";
}): string | null {
  return integration.state === "connected"
    ? integration.configurationUrl ?? integration.connectUrl
    : integration.connectUrl;
}

export function sentryConnectionUrl(
  connectUrl: string,
  options: { accountId?: string; freshInstall?: boolean } = {},
): string {
  const url = new URL(connectUrl, "https://responder.local");
  url.searchParams.set("returnTo", "/settings");
  if (options.accountId) {
    url.searchParams.set("integrationAccountId", options.accountId);
  }
  if (options.freshInstall) url.searchParams.set("mode", "install");
  return `${url.pathname}${url.search}`;
}
