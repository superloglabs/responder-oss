import * as Sentry from "@sentry/node";
import { organizationErrorTags } from "@responder/core/observability/sentry-identity";
import type { Event } from "@sentry/node";
import {
  sentryEnvironment,
  sentryRelease,
} from "@responder/core/observability/sentry";
import { slackErrorLogFields } from "@responder/core/integrations/slack-live-card";

export interface WorkerErrorContext {
  operation:
    | "automation"
    | "investigation"
    | "linear_ticket"
    | "remediation"
    | "sandbox_cleanup"
    | "slack_delivery"
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
// say what failed.
function aggregatedErrorsForMonitoring(
  value: unknown,
  secrets: readonly string[],
): { message: string; name: string }[] {
  if (!(value instanceof AggregateError)) return [];
  return value.errors.slice(0, 10).map((item: unknown) => {
    const error = asError(item);
    return {
      message: error
        ? redactString(error.message, secrets).slice(0, 2_000) ||
          "Worker operation failed"
        : "Non-Error exception",
      name: error?.name ?? typeof item,
    };
  });
}

function scrubWorkerSentryEvent(
  event: Event,
  environment: NodeJS.ProcessEnv,
): Event {
  const secrets = eventSecrets(environment);
  redactEventValue(event, secrets, new WeakSet());

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

export function initializeErrorMonitoring(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const dsn = environment.SENTRY_DSN?.trim();
  if (!dsn) return false;
  if (Sentry.isInitialized()) {
    configureEventScrubbing(environment);
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
    configureEventScrubbing(environment);
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
      if (aggregatedErrors.length > 0) {
        scope.setContext("aggregated_errors", { errors: aggregatedErrors });
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
  if (!errorMonitoringEnabled) return false;
  return Sentry.flush(timeout).catch(() => false);
}
