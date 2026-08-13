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
