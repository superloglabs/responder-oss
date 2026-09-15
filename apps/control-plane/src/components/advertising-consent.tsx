import { useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import {
  setAdvertisingConsent,
  shouldOfferAdvertisingConsent,
  startAdvertisingTracking,
  subscribeAdvertisingConsent,
} from "../advertising-consent";
import { focusMainContent } from "../advertising-consent-focus";
import { Button, IconButton } from "../design-system";

interface AdvertisingConsentPromptProps {
  onAccept: () => void;
  onEssentialOnly: () => void;
}

export function AdvertisingConsentPrompt({
  onAccept,
  onEssentialOnly,
}: AdvertisingConsentPromptProps) {
  return (
    <section
      aria-label="Cookie preferences"
      className="advertisingConsent"
    >
      <IconButton
        aria-label="Use essential cookies only"
        className="advertisingConsent__close"
        onClick={onEssentialOnly}
        variant="ghost"
      >
        <svg
          aria-hidden="true"
          fill="none"
          height="20"
          viewBox="0 0 24 24"
          width="20"
        >
          <path
            d="M6 6l12 12M18 6 6 18"
            stroke="currentColor"
            strokeLinecap="round"
            strokeWidth="1.5"
          />
        </svg>
      </IconButton>
      <p>
        Responder uses necessary cookies to keep the site secure and working.
        With your permission, Reddit and X can measure advertising visits and
        signups. Select “Allow advertising” to opt in. Select “Use essential
        only” or close this prompt to continue without advertising tracking.
        Read our <Link to="/privacy">Privacy Policy</Link>.
      </p>
      <div className="advertisingConsent__actions">
        <Button onClick={onEssentialOnly} variant="secondary">
          Use essential only
        </Button>
        <Button onClick={onAccept} variant="primary">
          Allow advertising
        </Button>
      </div>
    </section>
  );
}

export function AdvertisingConsent() {
  const [announcement, setAnnouncement] = useState("");
  const isVisible = useSyncExternalStore(
    subscribeAdvertisingConsent,
    shouldOfferAdvertisingConsent,
    () => false,
  );

  function useEssentialOnly() {
    focusMainContent();
    setAnnouncement("Advertising tracking disabled.");
    setAdvertisingConsent("essential");
  }

  function allowAdvertising() {
    focusMainContent();
    setAnnouncement("Advertising tracking allowed.");
    setAdvertisingConsent("all");
    startAdvertisingTracking();
  }

  return (
    <>
      {announcement ? (
        <span className="dsVisuallyHidden" role="status">
          {announcement}
        </span>
      ) : null}
      {isVisible ? (
        <AdvertisingConsentPrompt
          onAccept={allowAdvertising}
          onEssentialOnly={useEssentialOnly}
        />
      ) : null}
    </>
  );
}
