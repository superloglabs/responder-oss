import type { PostHog } from "posthog-js";

const DEFAULT_POSTHOG_HOST = "https://eu.i.posthog.com";
const ANALYTICS_PROJECT = "responder";

let clientPromise: Promise<PostHog | null> | undefined;
let lastPageViewUrl: string | undefined;

async function getBrowserAnalyticsClient() {
  if (typeof window === "undefined") return null;
  if (clientPromise) return clientPromise;

  const projectToken = import.meta.env.VITE_POSTHOG_PROJECT_TOKEN?.trim();
  if (!projectToken) return null;

  clientPromise = import("posthog-js")
    .then(({ default: client }) => {
      const apiHost =
        import.meta.env.VITE_POSTHOG_HOST?.trim() || DEFAULT_POSTHOG_HOST;

      client.init(projectToken, {
        api_host: apiHost,
        capture_pageview: false,
        defaults: "2026-05-30",
        disable_session_recording: false,
        person_profiles: "identified_only",
        session_recording: {
          maskAllInputs: true,
        },
        loaded(loadedClient) {
          loadedClient.register({ project: ANALYTICS_PROJECT });
          loadedClient.startSessionRecording(true);
        },
      });

      return client;
    })
    .catch(() => {
      clientPromise = undefined;
      return null;
    });

  return clientPromise;
}

export async function initializeBrowserAnalytics() {
  await getBrowserAnalyticsClient();
}

export async function captureBrowserPageView(url: string) {
  if (lastPageViewUrl === url) return;
  lastPageViewUrl = url;

  const client = await getBrowserAnalyticsClient();
  if (!client) {
    lastPageViewUrl = undefined;
    return;
  }

  client.capture("$pageview", { $current_url: url });
}

export interface BrowserAnalyticsUser {
  id: string;
  email?: string | null;
  name?: string | null;
}

export async function identifyBrowserUser(
  user: BrowserAnalyticsUser,
  organizationId?: string | null,
) {
  const client = await getBrowserAnalyticsClient();
  if (!client) return;

  client.identify(user.id, {
    email: user.email ?? undefined,
    name: user.name ?? undefined,
  });

  if (organizationId) {
    client.group("organization", organizationId);
  }
}

export async function resetBrowserAnalytics() {
  const client = await getBrowserAnalyticsClient();
  lastPageViewUrl = undefined;
  client?.reset();
}
