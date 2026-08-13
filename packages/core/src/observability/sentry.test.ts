import { describe, expect, it } from "vitest";
import {
  sentryEnvironment,
  sentryRelease,
  sentrySampleRate,
} from "./sentry";

describe("Sentry configuration", () => {
  it("accepts sample rates from zero through one", () => {
    expect(sentrySampleRate("0")).toBe(0);
    expect(sentrySampleRate("0.25")).toBe(0.25);
    expect(sentrySampleRate("1")).toBe(1);
  });

  it("falls back for missing or invalid sample rates", () => {
    expect(sentrySampleRate(undefined, 0.1)).toBe(0.1);
    expect(sentrySampleRate("", 0.1)).toBe(0.1);
    expect(sentrySampleRate("-0.1", 0.1)).toBe(0.1);
    expect(sentrySampleRate("1.1", 0.1)).toBe(0.1);
    expect(sentrySampleRate("not-a-number", 0.1)).toBe(0.1);
  });

  it("prefers explicit environment and release values", () => {
    expect(
      sentryEnvironment({
        NODE_ENV: "production",
        SENTRY_ENVIRONMENT: "staging",
      }),
    ).toBe("staging");
    expect(
      sentryRelease({
        SENTRY_RELEASE: "responder@1.2.3",
      }),
    ).toBe("responder@1.2.3");
  });

  it("treats empty values as absent", () => {
    expect(
      sentryEnvironment({ NODE_ENV: "production", SENTRY_ENVIRONMENT: " " }),
    ).toBe("production");
    expect(sentryRelease({ SENTRY_RELEASE: " " })).toBeUndefined();
  });
});
