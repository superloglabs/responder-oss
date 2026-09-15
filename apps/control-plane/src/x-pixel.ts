// X universal website tag (uwt.js) bootstrap. Browser and server-side
// Conversion API reports use the user id as the deduplication key, so X counts
// a signup reported through both channels once.

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

export function xPixelId(eventId: string): string | null {
  return /^tw-([a-z0-9]+)-[a-z0-9]+$/i.exec(eventId)?.[1] ?? null;
}

export function xSignupEventIds(
  environment: ImportMetaEnv = import.meta.env,
): string[] {
  const eventIds = [
    environment.VITE_X_ADS_SIGNUP_EVENT_ID,
    ...(environment.VITE_X_ADS_SIGNUP_EVENT_IDS?.split(",") ?? []),
  ];
  const validEventIds = eventIds.flatMap((value) => {
    const eventId = value?.trim();
    return eventId && xPixelId(eventId) ? [eventId] : [];
  });
  return [...new Set(validEventIds)];
}

const configuredPixelIds = new Set<string>();

export function initializeXPixel() {
  if (typeof window === "undefined") return;
  const pixelIds = xSignupEventIds()
    .map(xPixelId)
    .filter((pixelId): pixelId is string => pixelId !== null);
  if (pixelIds.length === 0) return;

  if (!window.twq) {
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
  }

  for (const pixelId of pixelIds) {
    if (configuredPixelIds.has(pixelId)) continue;
    configuredPixelIds.add(pixelId);
    window.twq("config", pixelId);
  }
}

const trackedConversions = new Set<string>();

export function trackXSignupPixel(conversionId: string) {
  if (typeof window === "undefined" || !window.twq) return;
  for (const eventId of xSignupEventIds()) {
    const conversionKey = `${eventId}:${conversionId}`;
    if (trackedConversions.has(conversionKey)) continue;
    trackedConversions.add(conversionKey);
    window.twq("event", eventId, { conversion_id: conversionId });
  }
}
