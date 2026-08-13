export function integrationActionUrl(integration: {
  configurationUrl: string | null;
  connectUrl: string | null;
  state: "available" | "coming_soon" | "connected" | "setup_required";
}): string | null {
  return integration.state === "connected"
    ? integration.configurationUrl ?? integration.connectUrl
    : integration.connectUrl;
}
