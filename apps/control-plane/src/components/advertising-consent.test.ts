// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, StaticRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const consentState = vi.hoisted(() => ({
  subscribers: new Set<() => void>(),
  visible: true,
}));

const consentMocks = vi.hoisted(() => ({
  setAdvertisingConsent: vi.fn((choice: "all" | "essential") => {
    void choice;
    consentState.visible = false;
    for (const subscriber of consentState.subscribers) subscriber();
  }),
  startAdvertisingTracking: vi.fn(),
}));

vi.mock("../advertising-consent", () => ({
  setAdvertisingConsent: consentMocks.setAdvertisingConsent,
  shouldOfferAdvertisingConsent: () => consentState.visible,
  startAdvertisingTracking: consentMocks.startAdvertisingTracking,
  subscribeAdvertisingConsent: (subscriber: () => void) => {
    consentState.subscribers.add(subscriber);
    return () => consentState.subscribers.delete(subscriber);
  },
}));

import {
  AdvertisingConsent,
  AdvertisingConsentPrompt,
} from "./advertising-consent";

beforeEach(() => {
  consentState.subscribers.clear();
  consentState.visible = true;
  vi.clearAllMocks();
  document.body.replaceChildren();
});

describe("AdvertisingConsentPrompt", () => {
  it("offers equal access to opt in, continue without ads, and read the privacy policy", () => {
    const prompt = createElement(AdvertisingConsentPrompt, {
      onAccept: vi.fn(),
      onEssentialOnly: vi.fn(),
    });
    const html = renderToStaticMarkup(
      createElement(StaticRouter, { location: "/" }, prompt),
    );

    expect(html).toContain('aria-label="Cookie preferences"');
    expect(html).toContain('aria-label="Use essential cookies only"');
    expect(html).toContain("Use essential only");
    expect(html).toContain("Allow advertising");
    expect(html).toContain('href="/privacy"');
    expect(html).toContain("Reddit and X");
  });

  it.each([
    {
      action: "Allow advertising",
      announcement: "Advertising tracking allowed.",
      choice: "all",
      startsTracking: true,
    },
    {
      action: "Use essential only",
      announcement: "Advertising tracking disabled.",
      choice: "essential",
      startsTracking: false,
    },
  ] as const)(
    "closes the rendered prompt and restores focus after $action",
    async ({ action, announcement, choice, startsTracking }) => {
      const main = document.createElement("main");
      const container = document.createElement("div");
      document.body.append(main, container);
      const root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(
            MemoryRouter,
            null,
            createElement(AdvertisingConsent),
          ),
        );
      });

      const button = [...container.querySelectorAll("button")].find(
        (candidate) => candidate.textContent?.trim() === action,
      );
      expect(button).toBeDefined();

      await act(async () => {
        button?.click();
      });

      expect(container.querySelector(".advertisingConsent")).toBeNull();
      expect(document.activeElement).toBe(main);
      expect(main.getAttribute("tabindex")).toBe("-1");
      expect(container.querySelector('[role="status"]')?.textContent).toBe(
        announcement,
      );
      expect(consentMocks.setAdvertisingConsent).toHaveBeenCalledWith(choice);
      expect(consentMocks.startAdvertisingTracking).toHaveBeenCalledTimes(
        startsTracking ? 1 : 0,
      );

      await act(async () => root.unmount());
    },
  );
});
