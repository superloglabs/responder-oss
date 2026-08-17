import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProviderGlyph } from "./icons";

describe("ProviderGlyph", () => {
  it("announces the provider when the glyph carries meaning", () => {
    const markup = renderToStaticMarkup(
      createElement(ProviderGlyph, { provider: "github" }),
    );

    expect(markup).toContain('aria-label="GitHub"');
    expect(markup).toContain('role="img"');
    expect(markup).toContain(">GH</span>");
  });

  it("stays decorative when adjacent copy already names the provider", () => {
    const markup = renderToStaticMarkup(
      createElement(ProviderGlyph, {
        decorative: true,
        provider: "google",
      }),
    );

    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain("aria-label");
    expect(markup).not.toContain("role=");
  });

  it("renders the Upstash brand mark instead of a text abbreviation", () => {
    const markup = renderToStaticMarkup(
      createElement(ProviderGlyph, { provider: "upstash" }),
    );

    expect(markup).toContain('aria-label="Upstash"');
    expect(markup).toContain('class="providerGlyph__logo"');
    expect(markup).toContain("#00E9A3");
    expect(markup).not.toContain(">UP</span>");
  });
});
