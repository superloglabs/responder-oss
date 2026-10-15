import { apiErrorMessage } from "./agents-api";
import type { TelemetrySourceSummary } from "../../../packages/core/src/db/telemetry-sources";

export type { TelemetrySourceSummary };

const base = "/api/telemetry/sources";

export type TelemetrySourceOverview = {
  accounts: Array<{ displayName: string; id: string; provider: "gcp" | "vercel" }>;
  // Whether this installation can connect each provider.
  providers: { gcp: boolean; vercel: boolean };
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

// Regions offered for the AWS stack, most used first.
export const awsRegions = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-central-1",
  "eu-central-2",
  "eu-north-1",
  "eu-south-1",
  "eu-south-2",
  "ap-south-1",
  "ap-south-2",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-southeast-3",
  "ap-southeast-4",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-northeast-3",
  "ap-east-1",
  "ca-central-1",
  "ca-west-1",
  "sa-east-1",
  "me-south-1",
  "me-central-1",
  "il-central-1",
  "af-south-1",
  "mx-central-1",
] as const;
