import * as Sentry from "@sentry/hono/node";
import {
  sentryEnvironment,
  sentryRelease,
  sentrySampleRate,
} from "@responder/core/observability/sentry";
import { scrubSentryEvent } from "./sentry-scrubbing.js";

export function initializeServerMonitoring(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const dsn = environment.SENTRY_DSN?.trim();
  if (!dsn) return false;
  if (Sentry.isInitialized()) return true;

  try {
    Sentry.init({
      beforeSend: scrubSentryEvent,
      dsn,
      environment: sentryEnvironment(environment),
      release: sentryRelease(environment),
      sendDefaultPii: false,
      tracesSampleRate: sentrySampleRate(
        environment.SENTRY_TRACES_SAMPLE_RATE,
      ),
    });
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
  return Sentry.flush(timeout).catch(() => false);
}
