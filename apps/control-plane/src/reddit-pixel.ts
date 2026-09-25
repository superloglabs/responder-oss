// Reddit Pixel. The pixel is disabled unless a deployment provides its public
// browser identifier at build time, and c15t loads it only after the visitor
// grants marketing consent.

import { redditPixel } from "@c15t/scripts/reddit-pixel";

type Script = ReturnType<typeof redditPixel>;

export function redditPixelId(
  environment: ImportMetaEnv = import.meta.env,
): string | null {
  const pixelId = environment.VITE_REDDIT_PIXEL_ID?.trim();
  return pixelId && /^a2_[a-z0-9]+$/i.test(pixelId) ? pixelId : null;
}

export function redditPixelScripts(
  environment: ImportMetaEnv = import.meta.env,
): Script[] {
  const pixelId = redditPixelId(environment);
  if (!pixelId) return [];
  return [
    redditPixel({
      pixelId,
      initOptions: { useDecimalCurrencyValues: true },
    }),
  ];
}

const trackedSignupConversions = new Set<string>();

export function trackRedditSignupPixel(conversionId: string) {
  // window.rdt exists only once c15t has loaded the pixel with consent.
  if (
    typeof window === "undefined" ||
    !window.rdt ||
    trackedSignupConversions.has(conversionId)
  ) {
    return;
  }
  trackedSignupConversions.add(conversionId);
  window.rdt("track", "SignUp", { conversionId });
}
