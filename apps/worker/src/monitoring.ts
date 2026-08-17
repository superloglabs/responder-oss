import * as Sentry from "@sentry/node";
import type { ErrorEvent } from "@sentry/node";
import {
  sentryEnvironment,
  sentryRelease,
} from "@responder/core/observability/sentry";

export interface WorkerErrorContext {
  operation: "investigation" | "remediation" | "sandbox_cleanup" | "worker";
  investigationId?: string;
  jobId?: string;
  organizationId?: string;
  requestId?: string;
  sandboxId?: string;
  sourceInvestigationId?: string;
}

let errorMonitoringEnabled = false;

const secretEnvironmentNames = [
  "OPENAI_API_KEY",
  "DAYTONA_API_KEY",
  "DATABASE_PASSWORD",
  "CREDENTIAL_ENCRYPTION_KEY",
  "INTERNAL_INGEST_TOKEN",
] as const;

function redactEventValue(
  value: unknown,
  secrets: readonly string[],
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "string") {
    return secrets.reduce(
      (redacted, secret) => redacted.replaceAll(secret, "[redacted]"),
      value,
    );
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
    record[key] = redactEventValue(item, secrets, seen);
  }
  return record;
}

function scrubWorkerSentryEvent(
  event: ErrorEvent,
  environment: NodeJS.ProcessEnv,
): ErrorEvent {
  const secrets = secretEnvironmentNames.flatMap((name) => {
    const value = environment[name];
    return value ? [value] : [];
  });
  redactEventValue(event, secrets, new WeakSet());

  for (const exception of event.exception?.values ?? []) {
    if (exception.value && exception.value.length > 2_000) {
      exception.value = exception.value.slice(0, 2_000);
    }
  }
  return event;
}

export function initializeErrorMonitoring(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const dsn = environment.SENTRY_DSN?.trim();
  if (!dsn) return false;
  if (Sentry.isInitialized()) {
    errorMonitoringEnabled = true;
    return true;
  }

  try {
    Sentry.init({
      beforeSend: (event) => scrubWorkerSentryEvent(event, environment),
      defaultIntegrations: false,
      dsn,
      environment: sentryEnvironment(environment),
      release: sentryRelease(environment),
      sendDefaultPii: false,
      tracesSampleRate: 0,
    });
    errorMonitoringEnabled = true;
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
    Sentry.withScope((scope) => {
      scope.setTag("responder.operation", context.operation);
      scope.setContext("responder", { ...context });
      Sentry.captureException(error);
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
  if (!errorMonitoringEnabled) return false;
  return Sentry.flush(timeout).catch(() => false);
}
