// Reddit Pixel bootstrap. The pixel is disabled unless a deployment provides
// its public browser identifier at build time.

interface RedditPixel {
  (...args: unknown[]): void;
  callQueue: unknown[][];
  sendEvent?: (...args: unknown[]) => void;
}

declare global {
  interface Window {
    rdt?: RedditPixel;
  }
}

export function redditPixelId(
  environment: ImportMetaEnv = import.meta.env,
): string | null {
  const pixelId = environment.VITE_REDDIT_PIXEL_ID?.trim();
  return pixelId && /^a2_[a-z0-9]+$/i.test(pixelId) ? pixelId : null;
}

let initializedPixelId: string | null = null;

export function initializeRedditPixel() {
  if (typeof window === "undefined") return;
  const pixelId = redditPixelId();
  if (!pixelId || initializedPixelId === pixelId) return;

  if (!window.rdt) {
    // Queue commands until pixel.js installs sendEvent, mirroring Reddit's
    // official snippet without blocking the application on an ad server.
    const rdt: RedditPixel = Object.assign(
      (...args: unknown[]) => {
        if (rdt.sendEvent) rdt.sendEvent(...args);
        else rdt.callQueue.push(args);
      },
      { callQueue: [] as unknown[][] },
    );
    window.rdt = rdt;
    const script = document.createElement("script");
    script.async = true;
    script.src = `https://www.redditstatic.com/ads/pixel.js?pixel_id=${encodeURIComponent(pixelId)}`;
    document.head.appendChild(script);
  }

  initializedPixelId = pixelId;
  window.rdt("init", pixelId, {
    optOut: false,
    useDecimalCurrencyValues: true,
  });
  window.rdt("track", "PageVisit");
}

const trackedSignupConversions = new Set<string>();

export function trackRedditSignupPixel(conversionId: string) {
  if (
    typeof window === "undefined" ||
    !window.rdt ||
    !initializedPixelId ||
    trackedSignupConversions.has(conversionId)
  ) {
    return;
  }
  trackedSignupConversions.add(conversionId);
  window.rdt("track", "SignUp", { conversionId });
}
