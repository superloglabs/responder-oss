import { apiErrorMessage } from "./agents-api";
import type { TelemetrySourceSummary } from "../../../packages/core/src/db/telemetry-sources";

export type { TelemetrySourceSummary };

const base = "/api/telemetry/sources";

export type TelemetrySourceOverview = {
  accounts: Array<{ displayName: string; id: string; provider: "gcp" | "railway" | "vercel" }>;
  // Whether this installation can connect each provider.
  providers: { gcp: boolean; railway?: boolean; vercel: boolean };
  sources: TelemetrySourceSummary[];
};

export type AwsStackLaunch = {
  deployCommand: string;
  // Null when this installation cannot host the template for quick-create.
  launchUrl: string | null;
  sourceId: string;
  stackName: string;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
  return body as T;
}

// Null when this workspace or cell cannot receive telemetry.
export async function fetchTelemetrySources(): Promise<TelemetrySourceOverview | null> {
  const response = await fetch(base);
  if (response.status === 404) return null;
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
  return body as TelemetrySourceOverview;
}

export function connectVercelSource(integrationAccountId: string): Promise<{ sourceId: string }> {
  return request("/vercel", { body: JSON.stringify({ integrationAccountId }), method: "POST" });
}

export function connectGcpSource(integrationAccountId: string): Promise<{ sourceId: string }> {
  return request("/gcp", { body: JSON.stringify({ integrationAccountId }), method: "POST" });
}

export type RailwayEnvironmentOption = {
  environmentId: string;
  environmentName: string;
  projectId: string;
  projectName: string;
  workspaceId: string;
  workspaceName: string;
};

// The environments one Railway connection shares, and the ones Superlog
// reads. Null when this workspace or cell cannot receive telemetry.
export type RailwayLogReading = {
  environments: RailwayEnvironmentOption[];
  sources: TelemetrySourceSummary[];
};

export async function fetchRailwayLogReading(integrationAccountId: string): Promise<RailwayLogReading | null> {
  const response = await fetch(`${base}/railway/${encodeURIComponent(integrationAccountId)}`);
  const body = (await response.json().catch(() => null)) as (RailwayLogReading & { error?: string }) | null;
  if (response.status === 404 && body?.error === "Sending telemetry is not available") return null;
  if (!response.ok || !body) throw new Error(apiErrorMessage(body, response.status));
  return { environments: body.environments ?? [], sources: body.sources ?? [] };
}

export function readRailwayEnvironment(integrationAccountId: string, environmentId: string): Promise<{ sourceId: string }> {
  return request("/railway", { body: JSON.stringify({ environmentId, integrationAccountId }), method: "POST" });
}

export function createAwsStack(region: string): Promise<AwsStackLaunch> {
  return request("/aws", { body: JSON.stringify({ region }), method: "POST" });
}

export async function removeTelemetrySource(sourceId: string): Promise<void> {
  await request(`/${encodeURIComponent(sourceId)}`, { method: "DELETE" });
}

export const awsTelemetryTemplatePath = `${base}/aws/template`;

// Data from a source within this long counts as arriving.
const receivingWindowMs = 15 * 60_000;

export function sourceHealth(
  source: Pick<TelemetrySourceSummary, "lastError" | "lastReceivedAt" | "status">,
  now: number = Date.now(),
): { label: string; tone: "danger" | "live" | "neutral" | "warning" } {
  if (source.status === "failed") return { label: "Error", tone: "danger" };
  if (source.lastReceivedAt && now - new Date(source.lastReceivedAt).getTime() < receivingWindowMs) {
    return source.lastError ? { label: "Receiving, with errors", tone: "warning" } : { label: "Receiving", tone: "live" };
  }
  if (source.lastReceivedAt) return { label: "No recent data", tone: "warning" };
  return { label: "Waiting for data", tone: "neutral" };
}

// Regions offered for the AWS stack, shared with the log subscription
// picker so the two cannot drift.
export { awsRegions } from "../../../packages/core/src/integrations/aws-regions";
