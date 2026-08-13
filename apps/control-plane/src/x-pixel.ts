// X universal website tag (uwt.js) bootstrap. The pixel reports the signup
// conversion from the browser until the server-side Conversion API path is
// credentialed; both send the user id as the deduplication key, so X counts a
// signup reported through both channels once.

interface Twq {
  (...args: unknown[]): void;
  exe?: (...args: unknown[]) => void;
  queue: unknown[];
  version: string;
}

declare global {
  interface Window {
    twq?: Twq;
  }
}

export function xSignupEventId(): string | null {
  return import.meta.env.VITE_X_ADS_SIGNUP_EVENT_ID?.trim() || null;
}

export function xPixelId(eventId: string): string | null {
  return /^tw-([a-z0-9]+)-[a-z0-9]+$/i.exec(eventId)?.[1] ?? null;
}

export function initializeXPixel() {
  if (typeof window === "undefined" || window.twq) return;
  const eventId = xSignupEventId();
  if (!eventId) return;
  const pixelId = xPixelId(eventId);
  if (!pixelId) return;

  // Queue commands until uwt.js loads and installs twq.exe, mirroring the
  // official snippet without blocking on X's servers.
  const twq: Twq = Object.assign(
    (...args: unknown[]) => {
      if (twq.exe) twq.exe(...args);
      else twq.queue.push(args);
    },
    { queue: [] as unknown[], version: "1.1" },
  );
  window.twq = twq;
  const script = document.createElement("script");
  script.async = true;
  script.src = "https://static.ads-twitter.com/uwt.js";
  document.head.appendChild(script);

  twq("config", pixelId);
}

const trackedConversionIds = new Set<string>();

export function trackXSignupPixel(conversionId: string) {
  if (typeof window === "undefined" || !window.twq) return;
  const eventId = xSignupEventId();
  if (!eventId) return;
  if (trackedConversionIds.has(conversionId)) return;
  trackedConversionIds.add(conversionId);
  window.twq("event", eventId, { conversion_id: conversionId });
}
