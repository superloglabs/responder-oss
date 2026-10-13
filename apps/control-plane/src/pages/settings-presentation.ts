export function integrationActionUrl(integration: {
  configurationUrl: string | null;
  connectUrl: string | null;
  state: "available" | "coming_soon" | "connected" | "setup_required";
}): string | null {
  return integration.state === "connected"
    ? integration.configurationUrl ?? integration.connectUrl
    : integration.connectUrl;
}

// A GitHub connection fails when its app installation was removed or suspended
// on GitHub while an automation still uses it. Installing the app again
// restores it.
export function githubNeedsReconnect(integration: {
  accounts: Array<{ status: "connected" | "error" | "pending" }>;
  id: string;
}): boolean {
  return integration.id === "github" &&
    integration.accounts.some((account) => account.status === "error");
}
