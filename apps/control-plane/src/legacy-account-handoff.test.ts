import { afterEach, describe, expect, it, vi } from "vitest";
import {
  explicitSignupIntent,
  legacyAccountHandoffConfig,
  legacySessionRoutingIntent,
  tryLegacyEmailSignIn,
} from "./legacy-account-handoff.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("legacy account handoff configuration", () => {
  it("is disabled unless both legacy origins are configured", () => {
    vi.stubEnv("VITE_LEGACY_AUTH_ORIGIN", "https://api.legacy.example");

    expect(legacyAccountHandoffConfig()).toBeNull();
  });

  it("builds a fixed auth endpoint and product destination", () => {
    vi.stubEnv("VITE_LEGACY_AUTH_ORIGIN", "https://api.legacy.example/path");
    vi.stubEnv("VITE_LEGACY_PRODUCT_ORIGIN", "https://legacy.example/project/1");
    vi.stubEnv("VITE_LEGACY_COOKIE_DOMAIN", ".legacy.example");

    expect(legacyAccountHandoffConfig()).toEqual({
      signInUrl: "https://api.legacy.example/api/auth/sign-in/email",
      targetUrl: "https://legacy.example/",
    });
  });

  it("rejects insecure remote origins", () => {
    vi.stubEnv("VITE_LEGACY_AUTH_ORIGIN", "http://api.legacy.example");
    vi.stubEnv("VITE_LEGACY_PRODUCT_ORIGIN", "https://legacy.example");
    vi.stubEnv("VITE_LEGACY_COOKIE_DOMAIN", ".legacy.example");

    expect(legacyAccountHandoffConfig()).toBeNull();
  });

  it("rejects origins that cannot share the configured cookie", () => {
    vi.stubEnv("VITE_LEGACY_AUTH_ORIGIN", "https://api.other.example");
    vi.stubEnv("VITE_LEGACY_PRODUCT_ORIGIN", "https://legacy.example");
    vi.stubEnv("VITE_LEGACY_COOKIE_DOMAIN", ".legacy.example");

    expect(legacyAccountHandoffConfig()).toBeNull();
  });
});

describe("legacy email sign in", () => {
  it("returns the legacy destination only after valid credentials", async () => {
    vi.stubEnv("VITE_LEGACY_AUTH_ORIGIN", "https://api.legacy.example");
    vi.stubEnv("VITE_LEGACY_PRODUCT_ORIGIN", "https://legacy.example");
    vi.stubEnv("VITE_LEGACY_COOKIE_DOMAIN", ".legacy.example");
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    await expect(
      tryLegacyEmailSignIn("person@example.com", "secret-password", fetcher),
    ).resolves.toBe("https://legacy.example/");
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.legacy.example/api/auth/sign-in/email",
      {
        body: JSON.stringify({
          email: "person@example.com",
          password: "secret-password",
        }),
        credentials: "include",
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("stays in the current sign-in flow when legacy credentials fail", async () => {
    vi.stubEnv("VITE_LEGACY_AUTH_ORIGIN", "https://api.legacy.example");
    vi.stubEnv("VITE_LEGACY_PRODUCT_ORIGIN", "https://legacy.example");
    vi.stubEnv("VITE_LEGACY_COOKIE_DOMAIN", ".legacy.example");
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));

    await expect(
      tryLegacyEmailSignIn("person@example.com", "wrong-password", fetcher),
    ).resolves.toBeNull();
  });

  it("stays in the current sign-in flow after a network failure", async () => {
    vi.stubEnv("VITE_LEGACY_AUTH_ORIGIN", "https://api.legacy.example");
    vi.stubEnv("VITE_LEGACY_PRODUCT_ORIGIN", "https://legacy.example");
    vi.stubEnv("VITE_LEGACY_COOKIE_DOMAIN", ".legacy.example");
    const fetcher = vi.fn().mockRejectedValue(new Error("network unavailable"));

    await expect(
      tryLegacyEmailSignIn("person@example.com", "secret-password", fetcher),
    ).resolves.toBeNull();
  });

  it("abandons a legacy request that does not settle", async () => {
    vi.useFakeTimers();
    vi.stubEnv("VITE_LEGACY_AUTH_ORIGIN", "https://api.legacy.example");
    vi.stubEnv("VITE_LEGACY_PRODUCT_ORIGIN", "https://legacy.example");
    vi.stubEnv("VITE_LEGACY_COOKIE_DOMAIN", ".legacy.example");
    const fetcher = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      }),
    );

    const result = tryLegacyEmailSignIn(
      "person@example.com",
      "secret-password",
      fetcher as typeof fetch,
      50,
    );
    await vi.advanceTimersByTimeAsync(50);

    await expect(result).resolves.toBeNull();
  });

  it("does not send credentials when handoff is not configured", async () => {
    const fetcher = vi.fn();

    await expect(
      tryLegacyEmailSignIn("person@example.com", "secret-password", fetcher),
    ).resolves.toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("legacy session routing intent", () => {
  it("clears the marker only for an explicit account creation", () => {
    expect(
      legacySessionRoutingIntent({ explicitSignup: true, newSocialUser: true }),
    ).toEqual({ clearMarker: true, lookupMarker: false, trackSocialSignup: true });
  });

  it("checks the marker for a first-time social sign in", () => {
    expect(
      legacySessionRoutingIntent({ explicitSignup: false, newSocialUser: true }),
    ).toEqual({ clearMarker: false, lookupMarker: true, trackSocialSignup: true });
  });

  it("checks the marker without signup tracking for a returning user", () => {
    expect(
      legacySessionRoutingIntent({ explicitSignup: false, newSocialUser: false }),
    ).toEqual({ clearMarker: false, lookupMarker: true, trackSocialSignup: false });
  });
});

describe("explicit signup intent", () => {
  it("accepts email signup intent without an OAuth token", () => {
    expect(explicitSignupIntent("email", null)).toBe(true);
  });

  it("accepts social signup intent only for the matching OAuth attempt", () => {
    expect(explicitSignupIntent("social:attempt-1", "attempt-1")).toBe(true);
    expect(explicitSignupIntent("social:attempt-1", "attempt-2")).toBe(false);
    expect(explicitSignupIntent("social:attempt-1", null)).toBe(false);
  });
});
