import { useState } from "react";
import { browserTimeZone } from "./dashboard-time-range";

const timeZoneKey = "responder.dashboardTimeZone";

// "browser", or a time zone this browser knows.
function storedTimeZone(): string {
  try {
    const stored = localStorage.getItem(timeZoneKey) ?? "browser";
    if (stored !== "browser") new Intl.DateTimeFormat(undefined, { timeZone: stored });
    return stored;
  } catch {
    return "browser";
  }
}

// The time zone the time picker and the times on a page use, remembered
// across pages.
export function useTimeZonePreference(): {
  changeTimeZone: (preference: string) => void;
  timeZone: string;
  timeZonePreference: string;
} {
  const [timeZonePreference, setTimeZonePreference] = useState(storedTimeZone);
  function changeTimeZone(preference: string) {
    setTimeZonePreference(preference);
    try {
      localStorage.setItem(timeZoneKey, preference);
    } catch {
      // The choice still applies to this page.
    }
  }
  return {
    changeTimeZone,
    timeZone: timeZonePreference === "browser" ? browserTimeZone() : timeZonePreference,
    timeZonePreference,
  };
}
