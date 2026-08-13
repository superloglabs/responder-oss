import * as Sentry from "@sentry/react";
import { sentrySampleRate } from "@responder/core/observability/sentry";

export interface BrowserMonitoringConfig {
  dsn?: string;
  environment?: string;
  release?: string;
  tracesSampleRate?: string;
}

const defaultConfig: BrowserMonitoringConfig = {
  dsn: import.meta.env.VITE_SENTRY_DSN,
  environment: import.meta.env.VITE_SENTRY_ENVIRONMENT ?? import.meta.env.MODE,
  release: import.meta.env.VITE_SENTRY_RELEASE,
  tracesSampleRate: import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE,
};

export function initializeBrowserMonitoring(
  config: BrowserMonitoringConfig = defaultConfig,
): boolean {
  const dsn = config.dsn?.trim();
  if (!dsn) return false;
  if (Sentry.isInitialized()) return true;

  const tracesSampleRate = sentrySampleRate(config.tracesSampleRate);
  Sentry.init({
    dsn,
    environment: config.environment?.trim() || undefined,
    integrations:
      tracesSampleRate > 0 ? [Sentry.browserTracingIntegration()] : [],
    release: config.release?.trim() || undefined,
    sendDefaultPii: false,
    tracesSampleRate,
  });
  return true;
}

export function setBrowserMonitoringIdentity(
  userId?: string,
  organizationId?: string | null,
) {
  Sentry.setUser(userId ? { id: userId } : null);
  Sentry.setTag("organization_id", organizationId ?? "");
}
