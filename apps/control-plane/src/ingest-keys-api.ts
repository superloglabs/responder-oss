import { apiErrorMessage } from "./agents-api";
import type { TelemetryIngestKeySummary } from "../../../packages/core/src/db/telemetry-ingest-keys";

export type { TelemetryIngestKeySummary };

const base = "/api/telemetry/ingest-keys";

// Null when this workspace or cell cannot receive telemetry.
export async function fetchIngestKeys(): Promise<TelemetryIngestKeySummary[] | null> {
  const response = await fetch(base);
  if (response.status === 404) return null;
  const body = (await response.json().catch(() => null)) as { keys: TelemetryIngestKeySummary[] } | null;
  if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
  return body?.keys ?? [];
}

export async function createIngestKey(input: { name: string }): Promise<{
  key: TelemetryIngestKeySummary;
  token: string;
}> {
  const response = await fetch(base, {
    body: JSON.stringify(input),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const body = (await response.json().catch(() => null)) as { key: TelemetryIngestKeySummary; token: string } | null;
  if (!response.ok || !body) throw new Error(apiErrorMessage(body, response.status));
  return body;
}

export async function revokeIngestKey(keyId: string): Promise<void> {
  const response = await fetch(`${base}/${encodeURIComponent(keyId)}`, { method: "DELETE" });
  if (!response.ok) throw new Error(apiErrorMessage(await response.json().catch(() => null), response.status));
}

// OpenTelemetry SDK settings for a key, exported so an app started from the
// same shell sees them. The SDK adds /v1/logs, /v1/traces and /v1/metrics to
// the endpoint.
export function otlpEnvironment(origin: string, token: string): string {
  return [
    `export OTEL_EXPORTER_OTLP_ENDPOINT=${origin.replace(/\/+$/u, "")}/api/ingest`,
    "export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf",
    `export OTEL_EXPORTER_OTLP_HEADERS=x-api-key=${token}`,
  ].join("\n");
}

// Shown in the prompt until the member creates a key on the page.
export const ingestKeyPlaceholder = "<ingest key>";

// A prompt for a coding agent that instruments the open project with the
// OpenTelemetry SDK and sends all three signals to this cell.
export function openTelemetryPrompt(origin: string, token: string = ingestKeyPlaceholder): string {
  return [
    "Instrument this project with OpenTelemetry so it sends logs, traces and metrics to Superlog.",
    "",
    "1. Use the official OpenTelemetry SDK for this project's language and runtime, with its automatic instrumentation for the frameworks and libraries the project uses.",
    "2. Export traces, metrics and logs over OTLP/HTTP with protobuf. Configure the exporters only through these environment variables, and add them to the project's example environment file:",
    "",
    otlpEnvironment(origin, token).replaceAll("export ", "   "),
    "",
    "3. Set the service.name and deployment.environment.name resource attributes.",
    "4. Connect the project's existing logger to the OpenTelemetry logs SDK so each log record carries its trace and span IDs. Keep writing logs to the console.",
    "5. Start the SDK before the application loads its other modules, and flush and shut it down when the process exits.",
    "6. Never commit the ingest key. Read it from the environment.",
    "",
    "Run the project's checks, then summarize what you changed and how to set the variables where the app is deployed.",
  ].join("\n");
}
