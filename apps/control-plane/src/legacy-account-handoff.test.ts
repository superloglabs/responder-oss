import { afterEach, describe, expect, it, vi } from "vitest";
import {
  legacyAccountHandoffConfig,
  legacySessionRoutingIntent,
  tryLegacyEmailSignIn,
} from "./legacy-account-handoff.js";

afterEach(() => {
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

    expect(legacyAccountHandoffConfig()).toEqual({
      signInUrl: "https://api.legacy.example/api/auth/sign-in/email",
      targetUrl: "https://legacy.example/",
    });
  });

  it("rejects insecure remote origins", () => {
    vi.stubEnv("VITE_LEGACY_AUTH_ORIGIN", "http://api.legacy.example");
    vi.stubEnv("VITE_LEGACY_PRODUCT_ORIGIN", "https://legacy.example");

    expect(legacyAccountHandoffConfig()).toBeNull();
  });
});

describe("legacy email sign in", () => {
  it("returns the legacy destination only after valid credentials", async () => {
    vi.stubEnv("VITE_LEGACY_AUTH_ORIGIN", "https://api.legacy.example");
    vi.stubEnv("VITE_LEGACY_PRODUCT_ORIGIN", "https://legacy.example");
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
      },
    );
  });

  it("stays in the current sign-in flow when legacy credentials fail", async () => {
    vi.stubEnv("VITE_LEGACY_AUTH_ORIGIN", "https://api.legacy.example");
    vi.stubEnv("VITE_LEGACY_PRODUCT_ORIGIN", "https://legacy.example");
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));

    await expect(
      tryLegacyEmailSignIn("person@example.com", "wrong-password", fetcher),
    ).resolves.toBeNull();
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
});
