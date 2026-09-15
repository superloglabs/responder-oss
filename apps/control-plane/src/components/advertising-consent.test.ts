import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { focusMainContent } from "../advertising-consent-focus";
import { AdvertisingConsentPrompt } from "./advertising-consent";

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

  it("moves focus to stable page content before the prompt closes", () => {
    const main = {
      focus: vi.fn(),
      hasAttribute: vi.fn(() => false),
      setAttribute: vi.fn(),
    };
    const document = {
      querySelector: vi.fn(() => main),
    } as unknown as Document;

    focusMainContent(document);

    expect(main.setAttribute).toHaveBeenCalledWith("tabindex", "-1");
    expect(main.focus).toHaveBeenCalledWith({ preventScroll: true });
  });
});
