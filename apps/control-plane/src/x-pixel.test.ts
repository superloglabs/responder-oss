import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let xPixel: typeof import("./x-pixel");

beforeEach(async () => {
  vi.resetModules();
  xPixel = await import("./x-pixel");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("xPixelId", () => {
  it("extracts the pixel id from a full event id", () => {
    expect(xPixel.xPixelId("tw-pixel1-event1")).toBe("pixel1");
  });

  it("rejects identifiers that are not full event ids", () => {
    expect(xPixel.xPixelId("pixel-only")).toBeNull();
    expect(xPixel.xPixelId("tw-pixelonly")).toBeNull();
    expect(xPixel.xPixelId("")).toBeNull();
  });
});

describe("xSignupEventIds", () => {
  it("is disabled when event ids are absent", () => {
    vi.stubEnv("VITE_X_ADS_SIGNUP_EVENT_ID", "");
    vi.stubEnv("VITE_X_ADS_SIGNUP_EVENT_IDS", "");

    expect(xPixel.xSignupEventIds()).toEqual([]);
  });

  it("uses the legacy singular browser event id", () => {
    vi.stubEnv("VITE_X_ADS_SIGNUP_EVENT_ID", "tw-pixel1-event1");

    expect(xPixel.xSignupEventIds()).toEqual(["tw-pixel1-event1"]);
  });

  it("combines, trims, validates, and deduplicates configured event ids", () => {
    vi.stubEnv("VITE_X_ADS_SIGNUP_EVENT_ID", "tw-pixel1-event1");
    vi.stubEnv(
      "VITE_X_ADS_SIGNUP_EVENT_IDS",
      " tw-pixel2-event2,invalid,tw-pixel1-event1 ",
    );

    expect(xPixel.xSignupEventIds()).toEqual([
      "tw-pixel1-event1",
      "tw-pixel2-event2",
    ]);
  });

  it("configures and reports a signup to each browser pixel once", () => {
    const twq = vi.fn();
    vi.stubGlobal("window", { twq });
    vi.stubEnv("VITE_X_ADS_SIGNUP_EVENT_ID", "tw-browser1-event1");
    vi.stubEnv("VITE_X_ADS_SIGNUP_EVENT_IDS", "tw-browser2-event2");

    xPixel.initializeXPixel();
    xPixel.trackXSignupPixel("user-1");
    xPixel.trackXSignupPixel("user-1");

    expect(twq.mock.calls).toEqual([
      ["config", "browser1"],
      ["config", "browser2"],
      ["event", "tw-browser1-event1", { conversion_id: "user-1" }],
      ["event", "tw-browser2-event2", { conversion_id: "user-1" }],
    ]);
  });
});
