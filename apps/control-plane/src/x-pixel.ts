// X universal website tag (uwt.js), loaded by c15t only after the visitor
// grants marketing consent. Browser and server-side Conversion API reports use
// the user id as the deduplication key, so X counts a signup reported through
// both channels once.

import { xPixel } from "@c15t/scripts/x-pixel";

type Script = ReturnType<typeof xPixel>;

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

export function xPixelScripts(
  environment: ImportMetaEnv = import.meta.env,
): Script[] {
  const pixelIds = [
    ...new Set(
      xSignupEventIds(environment)
        .map(xPixelId)
        .filter((pixelId): pixelId is string => pixelId !== null),
    ),
  ];
  const [firstPixelId, ...additionalPixelIds] = pixelIds;
  if (!firstPixelId) return [];

  // One uwt.js load serves every pixel; configure the others on the same queue.
  const script = xPixel({ pixelId: firstPixelId });
  return [
    {
      ...script,
      onBeforeLoad(info) {
        script.onBeforeLoad?.(info);
        for (const pixelId of additionalPixelIds) {
          window.twq?.("config", pixelId);
        }
      },
    },
  ];
}

const trackedConversions = new Set<string>();

export function trackXSignupPixel(conversionId: string) {
  // window.twq exists only once c15t has loaded the tag with consent.
  if (typeof window === "undefined" || !window.twq) return;
  for (const eventId of xSignupEventIds()) {
    const conversionKey = `${eventId}:${conversionId}`;
    if (trackedConversions.has(conversionKey)) continue;
    trackedConversions.add(conversionKey);
    window.twq("event", eventId, { conversion_id: conversionId });
  }
}
