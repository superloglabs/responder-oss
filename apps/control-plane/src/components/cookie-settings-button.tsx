import { useContext } from "react";
import { OpenConsentPreferences } from "../consent-preferences";

export function CookieSettingsButton({ className }: { className?: string }) {
  const openConsentPreferences = useContext(OpenConsentPreferences);

  return (
    <button
      className={className}
      onClick={() => openConsentPreferences?.()}
      type="button"
    >
      Cookie settings
    </button>
  );
}
