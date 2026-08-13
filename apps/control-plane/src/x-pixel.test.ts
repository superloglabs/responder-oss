import { afterEach, describe, expect, it, vi } from "vitest";
import { xPixelId, xSignupEventId } from "./x-pixel";

afterEach(() => {
  vi.unstubAllEnvs();
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

describe("xSignupEventId", () => {
  it("is disabled when the event id is absent", () => {
    vi.stubEnv("VITE_X_ADS_SIGNUP_EVENT_ID", "");

    expect(xSignupEventId()).toBeNull();
  });

  it("uses the configured browser event id", () => {
    vi.stubEnv("VITE_X_ADS_SIGNUP_EVENT_ID", "tw-pixel1-event1");

    expect(xSignupEventId()).toBe("tw-pixel1-event1");
  });
});
