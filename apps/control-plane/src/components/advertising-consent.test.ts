import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
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
});
