/// <reference types="vite/client" />

declare module "*.css";
declare module "@fontsource-variable/inter";

interface ImportMetaEnv {
  readonly VITE_POSTHOG_HOST?: string;
  readonly VITE_POSTHOG_PROJECT_TOKEN?: string;
  readonly VITE_SENTRY_DSN?: string;
  readonly VITE_SENTRY_ENVIRONMENT?: string;
  readonly VITE_SENTRY_RELEASE?: string;
  readonly VITE_SENTRY_TRACES_SAMPLE_RATE?: string;
  readonly VITE_X_ADS_SIGNUP_EVENT_ID?: string;
}
