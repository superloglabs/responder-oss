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

describe("Reddit Pixel", () => {
  it("initializes once and reports a page visit", () => {
    const rdt = vi.fn();
    vi.stubGlobal("window", { rdt });
    vi.stubEnv("VITE_REDDIT_PIXEL_ID", "a2_pixel123");

    redditPixel.initializeRedditPixel();
    redditPixel.initializeRedditPixel();

    expect(rdt.mock.calls).toEqual([
      [
        "init",
        "a2_pixel123",
        { optOut: false, useDecimalCurrencyValues: true },
      ],
      ["track", "PageVisit"],
    ]);
  });

  it("reports each signup conversion once", () => {
    const rdt = vi.fn();
    vi.stubGlobal("window", { rdt });
    vi.stubEnv("VITE_REDDIT_PIXEL_ID", "a2_pixel123");

    redditPixel.initializeRedditPixel();
    redditPixel.trackRedditSignupPixel("user-1");
    redditPixel.trackRedditSignupPixel("user-1");

    expect(rdt).toHaveBeenLastCalledWith("track", "SignUp", {
      conversionId: "user-1",
    });
    expect(rdt).toHaveBeenCalledTimes(3);
  });
});
