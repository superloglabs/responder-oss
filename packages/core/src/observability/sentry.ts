export type SentryEnvironment = Record<string, string | undefined>;

export function sentrySampleRate(
  value: string | undefined,
  fallback = 0,
): number {
  if (value === undefined || value.trim() === "") return fallback;

  const sampleRate = Number(value);
  return Number.isFinite(sampleRate) && sampleRate >= 0 && sampleRate <= 1
    ? sampleRate
    : fallback;
}

export function sentryEnvironment(
  environment: SentryEnvironment,
  fallback = "development",
): string {
  return (
    environment.SENTRY_ENVIRONMENT?.trim() ||
    environment.NODE_ENV?.trim() ||
    fallback
  );
}

export function sentryRelease(
  environment: SentryEnvironment,
): string | undefined {
  return environment.SENTRY_RELEASE?.trim() || undefined;
}

// Sentry sets up its integrations only when it has a transport, and it makes
// a transport only from a DSN. OTLP export without a Sentry DSN uses this
// placeholder with a transport that discards everything, so Sentry still
// instruments the process and nothing is sent to Sentry.
export const instrumentationOnlySentryDsn =
  "https://otlp@sentry.invalid/1";

export function discardingSentryTransport(): {
  flush: () => Promise<boolean>;
  send: () => Promise<Record<string, never>>;
} {
  return {
    flush: async () => true,
    send: async () => ({}),
  };
}
