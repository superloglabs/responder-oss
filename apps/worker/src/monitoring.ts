import * as Sentry from "@sentry/node";
import {
  sentryEnvironment,
  sentryRelease,
} from "@responder/core/observability/sentry";

export interface WorkerErrorContext {
  operation:
    | "investigation"
    | "linear_ticket"
    | "remediation"
    | "sandbox_cleanup"
    | "worker";
  investigationId?: string;
  jobId?: string;
  organizationId?: string;
  requestId?: string;
  sandboxId?: string;
  sourceInvestigationId?: string;
}

let errorMonitoringEnabled = false;

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

function sanitizedError(
  error: unknown,
  environment: NodeJS.ProcessEnv,
): Error {
  let message = error instanceof Error ? error.message : String(error);
  for (const name of [
    "OPENAI_API_KEY",
    "DAYTONA_API_KEY",
    "DATABASE_PASSWORD",
    "CREDENTIAL_ENCRYPTION_KEY",
    "INTERNAL_INGEST_TOKEN",
  ] as const) {
    const value = environment[name];
    if (value) message = message.replaceAll(value, "[redacted]");
  }
  return new Error(message.slice(0, 2_000));
}

export async function reportWorkerException(
  error: unknown,
  context: WorkerErrorContext,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!errorMonitoringEnabled) return;

  try {
    Sentry.withScope((scope) => {
      scope.setTag("responder.operation", context.operation);
      scope.setContext("responder", { ...context });
      Sentry.captureException(sanitizedError(error, environment));
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
