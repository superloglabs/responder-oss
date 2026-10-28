import * as Sentry from "@sentry/react";
import { setAttributes, setUser } from "@superlog/browser/api";
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

type BrowserTelemetryModule = Pick<
  typeof import("./browser-telemetry"),
  "startBrowserTelemetry"
>;

// Browser telemetry goes through a relay that accepts only signed-in users, so
// it starts after sign-in. @superlog/browser and OpenTelemetry are a separate
// chunk that loads only when telemetry is on; the identity calls below are
// part of the main bundle and apply once it starts.
export function startSignedInBrowserTelemetry(
  config: BrowserMonitoringConfig & { otelTracesSampleRate?: string } = {
    ...defaultConfig,
    otelTracesSampleRate: import.meta.env.VITE_OTEL_TRACES_SAMPLE_RATE,
  },
  load: () => Promise<BrowserTelemetryModule> = () => import("./browser-telemetry"),
): Promise<boolean> {
  const sampleRate = sentrySampleRate(config.otelTracesSampleRate);
  if (sampleRate <= 0) return Promise.resolve(false);
  return load()
    .then(({ startBrowserTelemetry }) => {
      const started = startBrowserTelemetry({
        environment: config.environment?.trim() || undefined,
        origin: window.location.origin,
        release: config.release?.trim() || undefined,
        sampleRate,
      });
      if (started) applyTelemetryIdentity();
      return started;
    })
    .catch(() => false);
}

let identity: { organizationId?: string | null; organizationName?: string | null; userId?: string; userName?: string } = {};

function applyTelemetryIdentity() {
  setUser(identity.userId ? { id: identity.userId, name: identity.userName } : null);
  setAttributes({
    "organization.id": identity.organizationId || undefined,
    "organization.name": identity.organizationId ? identity.organizationName || undefined : undefined,
  });
}

export function setBrowserMonitoringIdentity(
  userId?: string,
  organizationId?: string | null,
  userName?: string,
  organizationName?: string | null,
) {
  Sentry.setUser(userId ? { id: userId, username: userName } : null);
  Sentry.setTag("organization_id", organizationId ?? "");
  Sentry.setTag("organization_name", organizationId ? organizationName ?? "" : "");
  identity = { organizationId, organizationName, userId, userName };
  applyTelemetryIdentity();
}
