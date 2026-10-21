import { cellDirectory } from "../../../../packages/core/src/cells.js";

export function controlPlaneBaseUrl(): string {
  return process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
}

export type IntegrationCallbackProvider = Parameters<typeof integrationCallbackUrl>[0];

// The callback on this cell's own address: its RESPONDER_CELLS entry in a
// multi-cell deployment, otherwise BETTER_AUTH_URL. OAuth state carries it, so
// a callback that arrives at the shared public address can be sent to the cell
// that started the flow.
export function cellCallbackUrl(provider: IntegrationCallbackProvider): string {
  return `${cellOrigin()}/api/integrations/${provider}/callback`;
}

// This cell's own public address. Providers that push telemetry send it here,
// so it never depends on routing at the shared address.
export function cellOrigin(): string {
  const directory = cellDirectory();
  return (
    directory?.cells.find((cell) => cell.id === directory.current)?.url ??
    controlPlaneBaseUrl()
  ).replace(/\/+$/u, "");
}

export function integrationCallbackUrl(
  provider:
    | "axiom"
    | "clickstack"
    | "cloudflare"
    | "custom_mcp"
    | "dash0"
    | "datadog"
    | "discord"
    | "gcp"
    | "github"
    | "grafana"
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

export function axiomWebhookUrl(integrationAccountId: string): string {
  const callbackBaseUrl =
    process.env.RESPONDER_PUBLIC_URL ?? controlPlaneBaseUrl();
  return new URL(
    `/api/webhooks/axiom/${encodeURIComponent(integrationAccountId)}`,
    callbackBaseUrl,
  ).toString();
}

export function signozWebhookUrl(integrationAccountId: string): string {
  const callbackBaseUrl =
    process.env.RESPONDER_PUBLIC_URL ?? controlPlaneBaseUrl();
  return new URL(
    `/api/webhooks/signoz/${encodeURIComponent(integrationAccountId)}`,
    callbackBaseUrl,
  ).toString();
}

export function honeycombWebhookUrl(integrationAccountId: string): string {
  const callbackBaseUrl =
    process.env.RESPONDER_PUBLIC_URL ?? controlPlaneBaseUrl();
  return new URL(
    `/api/webhooks/honeycomb/${encodeURIComponent(integrationAccountId)}`,
    callbackBaseUrl,
  ).toString();
}

export function devrevWebhookUrl(integrationAccountId: string): string {
  const callbackBaseUrl =
    process.env.RESPONDER_PUBLIC_URL ?? controlPlaneBaseUrl();
  return new URL(
    `/api/webhooks/devrev/${encodeURIComponent(integrationAccountId)}`,
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
