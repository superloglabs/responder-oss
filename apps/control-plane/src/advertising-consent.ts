import { redditPixelId, initializeRedditPixel } from "./reddit-pixel";
import {
  advertisingConsentCookie,
  type AdvertisingConsentChoice,
} from "./advertising-consent-cookie";
import { forgetXClickId, rememberXClickId } from "./x-click-id";
import { initializeXPixel, xSignupEventIds } from "./x-pixel";

export type AdvertisingConsent = AdvertisingConsentChoice;

export interface AdvertisingTrackingConfiguration {
  reddit: boolean;
  x: boolean;
}

const advertisingConsentStorageKey = "responder-advertising-consent-v1";
const advertisingConsentSubscribers = new Set<() => void>();
let inMemoryAdvertisingConsent: AdvertisingConsent | null = null;

export function resolveAdvertisingConsent(
  value: string | null,
): AdvertisingConsent | null {
  return value === "all" || value === "essential" ? value : null;
}

export function getAdvertisingConsent(): AdvertisingConsent | null {
  if (typeof window === "undefined") return inMemoryAdvertisingConsent;
  try {
    return (
      resolveAdvertisingConsent(
        window.localStorage.getItem(advertisingConsentStorageKey),
      ) ?? inMemoryAdvertisingConsent
    );
  } catch {
    return inMemoryAdvertisingConsent;
  }
}

export function setAdvertisingConsent(consent: AdvertisingConsent) {
  try {
    window.localStorage.setItem(advertisingConsentStorageKey, consent);
    inMemoryAdvertisingConsent = null;
  } catch {
    inMemoryAdvertisingConsent = consent;
  }
  try {
    window.document.cookie = advertisingConsentCookie(
      consent,
      window.document.location.protocol === "https:",
    );
    if (consent === "essential") forgetXClickId();
  } catch {
    // Storage can be unavailable in hardened browser contexts. The in-memory
    // choice still governs client-side tracking for this page lifecycle.
  }
  for (const subscriber of advertisingConsentSubscribers) subscriber();
}

export function subscribeAdvertisingConsent(subscriber: () => void) {
  advertisingConsentSubscribers.add(subscriber);
  return () => advertisingConsentSubscribers.delete(subscriber);
}

export function configuredAdvertisingTracking(
  environment: ImportMetaEnv = import.meta.env,
): AdvertisingTrackingConfiguration {
  return {
    reddit: redditPixelId(environment) !== null,
    x: xSignupEventIds(environment).length > 0,
  };
}

function hasAdvertisingTracking(
  configuration: AdvertisingTrackingConfiguration,
) {
  return configuration.reddit || configuration.x;
}

export function shouldStartAdvertisingTracking(
  consent: AdvertisingConsent | null,
  configured: boolean,
) {
  return consent === "all" && configured;
}

export function startAdvertisingTracking(
  configuration = configuredAdvertisingTracking(),
) {
  if (configuration.reddit) initializeRedditPixel();
  if (configuration.x) {
    rememberXClickId();
    initializeXPixel();
  }
}

export function initializeConsentedAdvertisingTracking() {
  const configuration = configuredAdvertisingTracking();
  if (
    !shouldStartAdvertisingTracking(
      getAdvertisingConsent(),
      hasAdvertisingTracking(configuration),
    )
  ) {
    return;
  }
  startAdvertisingTracking(configuration);
}

export function shouldOfferAdvertisingConsent() {
  const configuration = configuredAdvertisingTracking();
  return (
    hasAdvertisingTracking(configuration) && getAdvertisingConsent() === null
  );
}
