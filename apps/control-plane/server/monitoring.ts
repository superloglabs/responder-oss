import * as Sentry from "@sentry/hono/node";
import type { NodeOptions } from "@sentry/node";
import {
  otlpExportConfigured,
  startNodeTelemetry,
  type NodeTelemetry,
} from "@responder/core/observability/opentelemetry";
import {
  discardingSentryTransport,
  instrumentationOnlySentryDsn,
  sentryEnvironment,
  sentryRelease,
  sentrySampleRate,
} from "@responder/core/observability/sentry";
import { scrubSentryEvent } from "./sentry-scrubbing.js";

let telemetry: NodeTelemetry | null = null;

// Requests that are not traced: load balancer health checks, telemetry
// ingest (including this service's own exports when it sends to its own
// cell), and browser telemetry relayed to the OTLP endpoint.
export function isUntracedRequest(urlPath: string): boolean {
  const path = urlPath.split("?")[0] ?? urlPath;
  return (
    path === "/api/health" ||
    path.startsWith("/api/ingest/") ||
    path.startsWith("/api/telemetry/browser/")
  );
}

// Call before the application modules are imported, so that Postgres and the
// other instrumented libraries are patched when they load.
export function initializeServerMonitoring(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const dsn = environment.SENTRY_DSN?.trim();
  const exportTelemetry = otlpExportConfigured(environment);
  if (!dsn && !exportTelemetry) return false;
  if (Sentry.isInitialized()) return true;

  try {
    const options: NodeOptions = {
      beforeSend: async (event) => {
        if (!dsn) return null;
        const organizationId = event.tags?.organization_id;
        // Loaded here so that initialization does not import the database.
        const { organizationErrorTags } = await import(
          "@responder/core/observability/sentry-identity"
        );
        // The shared lookup returns within 250 ms, even if the database stalls.
        event.tags = {
          ...event.tags,
          ...await organizationErrorTags(
            typeof organizationId === "string" ? organizationId : undefined,
          ),
        };
        return scrubSentryEvent(event);
      },
      // Without a DSN, Sentry only instruments the process for OTLP export.
      dsn: dsn || instrumentationOnlySentryDsn,
      environment: sentryEnvironment(environment),
      integrations: [
        Sentry.httpIntegration({
          ignoreIncomingRequests: (urlPath) => isUntracedRequest(urlPath),
        }),
        ...(exportTelemetry
          ? [Sentry.nativeNodeFetchIntegration({ spans: true })]
          : []),
      ],
      release: sentryRelease(environment),
      sendDefaultPii: false,
      // OpenTelemetry export owns the tracer provider and sends the same
      // spans to Sentry and the OTLP endpoint.
      skipOpenTelemetrySetup: exportTelemetry,
      tracesSampleRate: sentrySampleRate(
        environment.SENTRY_TRACES_SAMPLE_RATE,
        exportTelemetry ? 1 : 0,
      ),
      ...(dsn ? {} : { transport: discardingSentryTransport }),
    };
    const client = Sentry.init(options);
    if (exportTelemetry && client) {
      telemetry = startNodeTelemetry({
        environment,
        sentryClient: client,
        sentryContextManager: new Sentry.SentryContextManager(),
        serviceName: "responder-control-plane",
      });
      Sentry.validateOpenTelemetrySetup();
    }
    return true;
  } catch (error) {
    console.error(
      JSON.stringify({
        errorCode: error instanceof Error ? error.constructor.name : "unknown",
        event: "sentry_initialization_failed",
        service: "responder-control-plane",
      }),
    );
    return false;
  }
}

export async function flushServerMonitoring(timeout = 2_000): Promise<boolean> {
  if (!Sentry.isInitialized()) return false;
  const [sentryFlushed] = await Promise.all([
    Sentry.flush(timeout).catch(() => false),
    telemetry?.flush(timeout),
  ]);
  return sentryFlushed;
}
