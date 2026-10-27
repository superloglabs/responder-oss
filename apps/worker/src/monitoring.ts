import * as Sentry from "@sentry/node";
import type { Event } from "@sentry/node";
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

export interface WorkerErrorContext {
  operation:
    | "automation"
    | "error_issues"
    | "gcp_telemetry_pull"
    | "investigation"
    | "linear_ticket"
    | "remediation"
    | "sandbox_cleanup"
    | "slack_delivery"
    | "synthetic_checks"
    | "telemetry_alerts"
    | "worker";
  investigationId?: string;
  jobId?: string;
  organizationId?: string;
  requestId?: string;
  sandboxId?: string;
  sourceInvestigationId?: string;
  diagnostics?: Record<string, unknown>;
}

let errorMonitoringEnabled = false;
let telemetry: NodeTelemetry | null = null;
let eventScrubbingConfigured = false;
let eventScrubbingEnvironment: NodeJS.ProcessEnv = process.env;

const secretEnvironmentNames = [
  "OPENAI_API_KEY",
  "AI_GATEWAY_API_KEY",
  "DAYTONA_API_KEY",
  "DATABASE_PASSWORD",
  "CREDENTIAL_ENCRYPTION_KEY",
  "INTERNAL_INGEST_TOKEN",
] as const;
const secretEnvironmentName =
  /(?:ACCESS_KEY|API_KEY|AUTH_TOKEN|CREDENTIAL|DATABASE_URL|DSN|PASSWORD|PRIVATE_KEY|SECRET(?:_KEY)?|TOKEN)$/iu;
const secretEventKey =
  /(?:access[_-]?key|api[_-]?key|authorization|cookie|credential|password|private[_-]?key|secret|token)|^(?:buildEnv|env|envs|environmentVariables?)$/iu;

function eventSecrets(environment: NodeJS.ProcessEnv): string[] {
  const explicitNames = new Set<string>(secretEnvironmentNames);
  return Object.entries(environment).flatMap(([name, value]) =>
    value &&
    (explicitNames.has(name) ||
      (value.length >= 8 && secretEnvironmentName.test(name)))
      ? [value]
      : [],
  );
}

function redactString(value: string, secrets: readonly string[]): string {
  return secrets
    .reduce(
      (redacted, secret) => redacted.replaceAll(secret, "[redacted]"),
      value,
    )
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/giu, "$1 [redacted]")
    .replace(
      /([?&](?:access[_-]?(?:key|token)|api[_-]?key|client[_-]?secret|id[_-]?token|password|refresh[_-]?token|secret|token)=)[^&#\s]+/giu,
      "$1[redacted]",
    );
}

function redactEventValue(
  value: unknown,
  secrets: readonly string[],
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "string") {
    return redactString(value, secrets);
  }
  if (!value || typeof value !== "object" || seen.has(value)) return value;

  seen.add(value);
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      value[index] = redactEventValue(item, secrets, seen);
    }
    return value;
  }

  const record = value as Record<string, unknown>;
  for (const [key, item] of Object.entries(record)) {
    record[key] = secretEventKey.test(key)
      ? "[redacted]"
      : redactEventValue(item, secrets, seen);
  }
  return record;
}

// pg-boss emits worker failures as plain objects that copy an error's name,
// message, and stack.
function errorLike(
  value: unknown,
): { message: string; name?: string; stack?: string } | null {
  if (typeof value !== "object" || value === null) return null;
  const { message, name, stack } = value as Record<string, unknown>;
  if (typeof message !== "string") return null;
  return {
    message,
    ...(typeof name === "string" ? { name } : {}),
    ...(typeof stack === "string" ? { stack } : {}),
  };
}

export function monitoringErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return errorLike(error)?.message ?? String(error);
}

function asError(value: unknown): Error | null {
  if (value instanceof Error) return value;
  const fields = errorLike(value);
  if (!fields) return null;
  const error = new Error(fields.message);
  // Spreading an error drops its inherited name; the stack still starts with it.
  error.name =
    fields.name ?? fields.stack?.match(/^([A-Za-z]\w*):/u)?.[1] ?? "Error";
  error.stack = fields.stack;
  return error;
}

function errorForMonitoring(
  value: unknown,
  secrets: readonly string[],
): Error {
  const error = asError(value);
  if (!error) {
    return new Error("Worker operation failed with a non-Error exception");
  }

  const message = redactString(error.message, secrets).slice(0, 2_000);
  const sanitized = new Error(message || "Worker operation failed");
  sanitized.name = error.name;
  if (error.stack) {
    const frames = error.stack
      .split("\n")
      .slice(1)
      .filter((line) => /^\s+at\s/u.test(line))
      .slice(0, 100)
      .map((line) => redactString(line, secrets).slice(0, 1_000));
    sanitized.stack = [`${sanitized.name}: ${sanitized.message}`, ...frames].join(
      "\n",
    );
  }
  return sanitized;
}

// An AggregateError's message names only the operation; the errors it holds
// say what failed. Sentry replaces anything nested more than three levels
// into an event's contexts with "[Object]", so each error is one string
// directly under the context.
function aggregatedErrorsForMonitoring(
  value: unknown,
  secrets: readonly string[],
): Record<string, string> {
  if (!(value instanceof AggregateError)) return {};
  return Object.fromEntries(value.errors.slice(0, 10).map((item: unknown, index) => {
    const error = asError(item);
    const message = error
      ? redactString(error.message, secrets).slice(0, 2_000) ||
        "Worker operation failed"
      : "Non-Error exception";
    return [`error_${index + 1}`, `${error?.name ?? typeof item}: ${message}`];
  }));
}

function scrubWorkerSentryEvent(
  event: Event,
  environment: NodeJS.ProcessEnv,
): Event {
  const secrets = eventSecrets(environment);
  // sdkProcessingMetadata is never sent. On a transaction it holds the live
  // scopes of the span, and through them Sentry's own client, which the
  // redaction must not walk into and change.
  const skipped = new WeakSet<object>();
  if (event.sdkProcessingMetadata) skipped.add(event.sdkProcessingMetadata);
  redactEventValue(event, secrets, skipped);

  for (const exception of event.exception?.values ?? []) {
    if (exception.value && exception.value.length > 2_000) {
      exception.value = exception.value.slice(0, 2_000);
    }
  }
  return event;
}

function configureEventScrubbing(environment: NodeJS.ProcessEnv): void {
  eventScrubbingEnvironment = environment;
  if (eventScrubbingConfigured) return;

  Sentry.addEventProcessor((event) =>
    scrubWorkerSentryEvent(event, eventScrubbingEnvironment),
  );
  eventScrubbingConfigured = true;
}

// Call before the worker's modules are imported, so that Postgres and the
// other instrumented libraries are patched when they load.
export function initializeErrorMonitoring(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const dsn = environment.SENTRY_DSN?.trim();
  const exportTelemetry = otlpExportConfigured(environment);
  if (!dsn && !exportTelemetry) return false;
  if (Sentry.isInitialized()) {
    configureEventScrubbing(environment);
    errorMonitoringEnabled = Boolean(dsn);
    return true;
  }

  try {
    const client = Sentry.init({
      defaultIntegrations: false,
      // Without a DSN, Sentry only instruments the process for OTLP export.
      dsn: dsn || instrumentationOnlySentryDsn,
      environment: sentryEnvironment(environment),
      // Spans for outgoing requests, Postgres queries, and OpenAI calls, inside
      // the span of each queue job. Prompts and outputs are not recorded.
      integrations: exportTelemetry
        ? [
          Sentry.httpIntegration(),
          Sentry.nativeNodeFetchIntegration({ spans: true }),
          Sentry.postgresIntegration(),
          Sentry.openAIIntegration(),
        ]
        : [],
      release: sentryRelease(environment),
      sendDefaultPii: false,
      // OpenTelemetry export owns the tracer provider and sends the same
      // spans to Sentry and the OTLP endpoint.
      skipOpenTelemetrySetup: exportTelemetry,
      tracesSampleRate: exportTelemetry
        ? sentrySampleRate(environment.SENTRY_TRACES_SAMPLE_RATE, 1)
        : 0,
      ...(dsn ? {} : { transport: discardingSentryTransport }),
    });
    if (exportTelemetry && client) {
      telemetry = startNodeTelemetry({
        environment,
        sentryClient: client,
        sentryContextManager: new Sentry.SentryContextManager(),
        serviceName: "responder-worker",
      });
      Sentry.validateOpenTelemetrySetup();
    }
    configureEventScrubbing(environment);
    errorMonitoringEnabled = Boolean(dsn);
    return true;
  } catch (error) {
    console.error(
      JSON.stringify({
        errorCode: error instanceof Error ? error.constructor.name : "unknown",
        event: "sentry_initialization_failed",
      }),
    );
    return false;
  }
}

export async function reportWorkerException(
  error: unknown,
  context: WorkerErrorContext,
): Promise<void> {
  if (!errorMonitoringEnabled) return;

  try {
    // Loaded here so that initialization does not import the database.
    const [{ organizationErrorTags }, { slackErrorLogFields }] = await Promise.all([
      import("@responder/core/observability/sentry-identity"),
      import("@responder/core/integrations/slack-live-card"),
    ]);
    const organizationTags = await organizationErrorTags(context.organizationId);
    Sentry.withScope((scope) => {
      for (const [key, value] of Object.entries(organizationTags)) {
        scope.setTag(key, value);
      }
      const { diagnostics, ...responderContext } = context;
      scope.setTag("responder.operation", context.operation);
      scope.setContext("responder", responderContext);
      if (diagnostics) {
        scope.setContext("diagnostics", diagnostics);
      }
      if (context.operation === "slack_delivery") {
        scope.setContext("slack", slackErrorLogFields(error));
      }
      const secrets = eventSecrets(eventScrubbingEnvironment);
      const aggregatedErrors = aggregatedErrorsForMonitoring(error, secrets);
      if (Object.keys(aggregatedErrors).length > 0) {
        scope.setContext("aggregated_errors", aggregatedErrors);
      }
      Sentry.captureException(errorForMonitoring(error, secrets));
    });
  } catch (reportingError) {
    console.error(
      JSON.stringify({
        errorCode:
          reportingError instanceof Error
            ? reportingError.constructor.name
            : "unknown",
        event: "sentry_reporting_failed",
        operation: context.operation,
      }),
    );
  }
}

export async function flushWorkerMonitoring(timeout = 2_000): Promise<boolean> {
  const [sentryFlushed] = await Promise.all([
    errorMonitoringEnabled
      ? Sentry.flush(timeout).catch(() => false)
      : Promise.resolve(false),
    telemetry?.flush(timeout),
  ]);
  return sentryFlushed;
}
