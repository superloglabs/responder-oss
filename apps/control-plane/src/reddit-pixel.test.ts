import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let redditPixel: typeof import("./reddit-pixel");

beforeEach(async () => {
  vi.resetModules();
  redditPixel = await import("./reddit-pixel");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("redditPixelId", () => {
  it("is disabled when the pixel id is absent", () => {
    vi.stubEnv("VITE_REDDIT_PIXEL_ID", "");

    expect(redditPixel.redditPixelId()).toBeNull();
  });

  it("trims and validates a configured pixel id", () => {
    vi.stubEnv("VITE_REDDIT_PIXEL_ID", " a2_pixel123 ");

    expect(redditPixel.redditPixelId()).toBe("a2_pixel123");
  });

  it("rejects malformed pixel ids", () => {
    vi.stubEnv("VITE_REDDIT_PIXEL_ID", "pixel-only");

    expect(redditPixel.redditPixelId()).toBeNull();
  });
});

describe("redditPixelScripts", () => {
  it("is empty when the pixel is not configured", () => {
    vi.stubEnv("VITE_REDDIT_PIXEL_ID", "");

    expect(redditPixel.redditPixelScripts()).toEqual([]);
  });

  it("loads the Reddit pixel with marketing consent", () => {
    vi.stubEnv("VITE_REDDIT_PIXEL_ID", "a2_pixel123");

    expect(redditPixel.redditPixelScripts()).toEqual([
      expect.objectContaining({
        category: "marketing",
        id: "reddit-pixel",
        src: "https://www.redditstatic.com/ads/pixel.js",
      }),
    ]);
  });
});

describe("trackRedditSignupPixel", () => {
  it("does nothing until the pixel is loaded", () => {
    vi.stubGlobal("window", {});

    expect(() => redditPixel.trackRedditSignupPixel("user-1")).not.toThrow();
  });

  it("reports each signup conversion once", () => {
    const rdt = vi.fn();
    vi.stubGlobal("window", { rdt });

    redditPixel.trackRedditSignupPixel("user-1");
    redditPixel.trackRedditSignupPixel("user-1");

    expect(rdt.mock.calls).toEqual([
      ["track", "SignUp", { conversionId: "user-1" }],
    ]);
  });
});
