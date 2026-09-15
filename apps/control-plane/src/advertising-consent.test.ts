import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configuredAdvertisingTracking,
  resolveAdvertisingConsent,
  setAdvertisingConsent,
  shouldStartAdvertisingTracking,
} from "./advertising-consent";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("advertising consent", () => {
  it("recognizes only explicit saved choices", () => {
    expect(resolveAdvertisingConsent("all")).toBe("all");
    expect(resolveAdvertisingConsent("essential")).toBe("essential");
    expect(resolveAdvertisingConsent("unknown")).toBeNull();
    expect(resolveAdvertisingConsent(null)).toBeNull();
  });

  it("persists the choice for client and server checks", () => {
    const cookieWrites: string[] = [];
    const document = { location: { protocol: "https:" } } as Document;
    Object.defineProperty(document, "cookie", {
      set(value: string) {
        cookieWrites.push(value);
      },
    });
    const setItem = vi.fn();
    vi.stubGlobal("window", { document, localStorage: { setItem } });

    setAdvertisingConsent("all");

    expect(setItem).toHaveBeenCalledWith(
      "responder-advertising-consent-v1",
      "all",
    );
    expect(cookieWrites).toEqual([
      "responder_advertising_consent=all; Max-Age=31536000; Path=/; SameSite=Lax; Secure",
    ]);
  });

  it("clears saved click attribution when advertising is declined", () => {
    const cookieWrites: string[] = [];
    const document = { location: { protocol: "https:" } } as Document;
    Object.defineProperty(document, "cookie", {
      set(value: string) {
        cookieWrites.push(value);
      },
    });
    vi.stubGlobal("window", {
      document,
      localStorage: { setItem: vi.fn() },
    });

    setAdvertisingConsent("essential");

    expect(cookieWrites).toEqual([
      "responder_advertising_consent=essential; Max-Age=31536000; Path=/; SameSite=Lax; Secure",
      "responder_twclid=; Max-Age=0; Path=/; SameSite=Lax; Secure",
    ]);
  });

  it("does not load an advertising script before consent", async () => {
    vi.resetModules();
    const createElement = vi.fn();
    vi.stubGlobal("window", {
      localStorage: { getItem: vi.fn(() => null) },
    });
    vi.stubGlobal("document", { createElement });
    vi.stubEnv("VITE_REDDIT_PIXEL_ID", "a2_pixel123");
    const { initializeConsentedAdvertisingTracking } = await import(
      "./advertising-consent"
    );

    initializeConsentedAdvertisingTracking();

    expect(createElement).not.toHaveBeenCalled();
    expect(window.rdt).toBeUndefined();
  });

  it("uses the consent cookie when browser storage is unavailable", async () => {
    vi.resetModules();
    vi.stubGlobal("window", {
      document: {
        cookie: "responder_advertising_consent=all",
      },
      localStorage: {
        getItem: vi.fn(() => {
          throw new Error("storage unavailable");
        }),
      },
    });
    const { getAdvertisingConsent } = await import("./advertising-consent");

    expect(getAdvertisingConsent()).toBe("all");
  });

  it("prefers the server-visible cookie over stale browser storage", async () => {
    vi.resetModules();
    vi.stubGlobal("window", {
      document: {
        cookie: "responder_advertising_consent=essential",
      },
      localStorage: { getItem: vi.fn(() => "all") },
    });
    const { getAdvertisingConsent } = await import("./advertising-consent");

    expect(getAdvertisingConsent()).toBe("essential");
  });

  it("prefers the latest in-memory choice when storage writes fail", async () => {
    vi.resetModules();
    vi.stubGlobal("window", {
      document: { cookie: "", location: { protocol: "https:" } },
      localStorage: {
        getItem: vi.fn(() => "all"),
        setItem: vi.fn(() => {
          throw new Error("storage unavailable");
        }),
      },
    });
    const { getAdvertisingConsent, setAdvertisingConsent } = await import(
      "./advertising-consent"
    );

    setAdvertisingConsent("essential");

    expect(getAdvertisingConsent()).toBe("essential");
  });

  it("requires an explicit opt-in before starting advertising tracking", () => {
    expect(shouldStartAdvertisingTracking(null, true)).toBe(false);
    expect(shouldStartAdvertisingTracking("essential", true)).toBe(false);
    expect(shouldStartAdvertisingTracking("all", true)).toBe(true);
    expect(shouldStartAdvertisingTracking("all", false)).toBe(false);
  });

  it("shows the choice only when an advertising integration is configured", () => {
    expect(
      configuredAdvertisingTracking({
        VITE_REDDIT_PIXEL_ID: "a2_pixel123",
      } as ImportMetaEnv),
    ).toEqual({ reddit: true, x: false });
    expect(
      configuredAdvertisingTracking({
        VITE_X_ADS_SIGNUP_EVENT_ID: "tw-pixel1-event1",
      } as ImportMetaEnv),
    ).toEqual({ reddit: false, x: true });
    expect(configuredAdvertisingTracking({} as ImportMetaEnv)).toEqual({
      reddit: false,
      x: false,
    });
  });
});
