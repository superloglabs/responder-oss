import {
  ConsentBanner,
  ConsentDialog,
  ConsentManagerProvider,
  type Theme,
  useConsentManager,
} from "@c15t/react";
import { type ReactNode, useCallback, useEffect, useRef } from "react";
import { authClient } from "../auth-client";
import {
  allowBrowserAnalytics,
  revokeBrowserAnalytics,
} from "../browser-analytics";
import { OpenConsentPreferences } from "../consent-preferences";
import { forgetRedditClickId, rememberRedditClickId } from "../reddit-click-id";
import { redditPixelScripts } from "../reddit-pixel";
import { forgetXClickId, rememberXClickId } from "../x-click-id";
import { xPixelScripts } from "../x-pixel";
import "./consent-manager.css";

// Tokens read the --consent-* variables from consent-manager.css, which follow
// the app's color theme and which pages with their own palette can override.
const consentTheme = {
  colors: {
    primary: "var(--consent-primary)",
    primaryHover: "var(--consent-primary-hover)",
    surface: "var(--consent-surface)",
    surfaceHover: "var(--consent-surface)",
    border: "var(--consent-border)",
    borderHover: "var(--consent-border-hover)",
    text: "var(--consent-text)",
    textMuted: "var(--consent-text-muted)",
    textOnPrimary: "var(--consent-text-on-primary)",
    overlay: "rgb(0 0 0 / 40%)",
    switchTrack: "var(--consent-switch-track)",
    switchTrackActive: "var(--consent-primary)",
    switchThumb: "var(--consent-text-on-primary)",
  },
  typography: {
    fontFamily: "var(--consent-font-family)",
    fontSize: { sm: "0.875rem", base: "0.875rem", lg: "1rem" },
  },
  radius: { sm: "0.375rem", md: "0.5rem", lg: "1rem" },
  shadows: { lg: "0 16px 40px -12px rgb(0 0 0 / 45%)" },
  consentActions: {
    default: { variant: "neutral", mode: "lighter" },
    primary: { variant: "neutral", mode: "lighter" },
  },
  slots: {
    consentBannerFooter: {
      style: { borderTop: "1px solid var(--consent-divider)" },
    },
  },
} satisfies Theme;

const scripts = [...redditPixelScripts(), ...xPixelScripts()];

function ConsentEffects({ landingSearch }: { landingSearch: string }) {
  const { has, identifyUser } = useConsentManager();
  const measurementAllowed = has("measurement");
  const marketingAllowed = has("marketing");
  const session = authClient.useSession();
  const userId = session.data?.user?.id;
  const identifiedUserId = useRef<string | null>(null);

  useEffect(() => {
    if (measurementAllowed) void allowBrowserAnalytics();
  }, [measurementAllowed]);

  useEffect(() => {
    if (!marketingAllowed) return;
    rememberRedditClickId(landingSearch);
    rememberXClickId(landingSearch);
  }, [landingSearch, marketingAllowed]);

  // Link the consent record to the account so it can be found for access and
  // deletion requests.
  useEffect(() => {
    if (!userId || identifiedUserId.current === userId) return;
    identifiedUserId.current = userId;
    void identifyUser({ id: userId, identityProvider: "responder" });
  }, [identifyUser, userId]);

  return null;
}

function ConsentPreferencesProvider({ children }: { children: ReactNode }) {
  const { setActiveUI } = useConsentManager();
  const openConsentPreferences = useCallback(
    () => setActiveUI("dialog"),
    [setActiveUI],
  );

  return (
    <OpenConsentPreferences.Provider value={openConsentPreferences}>
      {children}
    </OpenConsentPreferences.Provider>
  );
}

/**
 * Records cookie consent through the c15t backend at /api/c15t, which applies
 * the visitor's regional policy, and loads analytics and advertising only
 * within the categories the visitor allows.
 */
export function ConsentManager({
  children,
  landingSearch,
}: {
  children: ReactNode;
  landingSearch: string;
}) {
  return (
    <ConsentManagerProvider
      options={{
        mode: "hosted",
        backendURL: "/api/c15t",
        callbacks: {
          onBeforeConsentRevocationReload: ({ preferences }) => {
            if (!preferences.measurement) void revokeBrowserAnalytics();
            if (!preferences.marketing) {
              forgetRedditClickId();
              forgetXClickId();
            }
          },
        },
        colorScheme: "light",
        consentCategories: ["necessary", "measurement", "marketing"],
        legalLinks: {
          privacyPolicy: { href: "/privacy", target: "_self" },
        },
        scripts,
        theme: consentTheme,
      }}
    >
      <ConsentBanner hideBranding legalLinks={["privacyPolicy"]} />
      <ConsentDialog hideBranding legalLinks={["privacyPolicy"]} />
      <ConsentEffects landingSearch={landingSearch} />
      <ConsentPreferencesProvider>{children}</ConsentPreferencesProvider>
    </ConsentManagerProvider>
  );
}
