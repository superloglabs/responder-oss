import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initializeXPixel,
  trackXSignupPixel,
  xPixelId,
  xSignupEventIds,
} from "./x-pixel";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("xPixelId", () => {
  it("extracts the pixel id from a full event id", () => {
    expect(xPixelId("tw-pixel1-event1")).toBe("pixel1");
  });

  it("rejects identifiers that are not full event ids", () => {
    expect(xPixelId("pixel-only")).toBeNull();
    expect(xPixelId("tw-pixelonly")).toBeNull();
    expect(xPixelId("")).toBeNull();
  });
});

describe("xSignupEventIds", () => {
  it("is disabled when event ids are absent", () => {
    vi.stubEnv("VITE_X_ADS_SIGNUP_EVENT_ID", "");
    vi.stubEnv("VITE_X_ADS_SIGNUP_EVENT_IDS", "");

    expect(xSignupEventIds()).toEqual([]);
  });

  it("uses the legacy singular browser event id", () => {
    vi.stubEnv("VITE_X_ADS_SIGNUP_EVENT_ID", "tw-pixel1-event1");

    expect(xSignupEventIds()).toEqual(["tw-pixel1-event1"]);
  });

  it("combines, trims, validates, and deduplicates configured event ids", () => {
    vi.stubEnv("VITE_X_ADS_SIGNUP_EVENT_ID", "tw-pixel1-event1");
    vi.stubEnv(
      "VITE_X_ADS_SIGNUP_EVENT_IDS",
      " tw-pixel2-event2,invalid,tw-pixel1-event1 ",
    );

    expect(xSignupEventIds()).toEqual([
      "tw-pixel1-event1",
      "tw-pixel2-event2",
    ]);
  });

  it("configures and reports a signup to each browser pixel once", () => {
    const twq = vi.fn();
    vi.stubGlobal("window", { twq });
    vi.stubEnv("VITE_X_ADS_SIGNUP_EVENT_ID", "tw-browser1-event1");
    vi.stubEnv("VITE_X_ADS_SIGNUP_EVENT_IDS", "tw-browser2-event2");

    initializeXPixel();
    trackXSignupPixel("user-1");
    trackXSignupPixel("user-1");

    expect(twq.mock.calls).toEqual([
      ["config", "browser1"],
      ["config", "browser2"],
      ["event", "tw-browser1-event1", { conversion_id: "user-1" }],
      ["event", "tw-browser2-event2", { conversion_id: "user-1" }],
    ]);
  });
});
