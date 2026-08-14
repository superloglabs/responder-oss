import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProviderGlyph } from "./icons";

describe("ProviderGlyph", () => {
  it("renders the GitHub logo and announces the provider when it carries meaning", () => {
    const markup = renderToStaticMarkup(
      createElement(ProviderGlyph, { provider: "github" }),
    );

    expect(markup).toContain('aria-label="GitHub"');
    expect(markup).toContain('role="img"');
    expect(markup).toContain("<svg");
    expect(markup).toContain('fill="currentColor"');
    expect(markup).not.toContain(">GH</span>");
  });

  it("stays decorative when adjacent copy already names the provider", () => {
    const markup = renderToStaticMarkup(
      createElement(ProviderGlyph, {
        decorative: true,
        provider: "google",
      }),
    );

    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain("<svg");
    expect(markup).toContain('fill="#4285f4"');
    expect(markup).not.toContain("aria-label");
    expect(markup).not.toContain("role=");
  });

  it("keeps text glyphs as a fallback for providers without a logo", () => {
    const markup = renderToStaticMarkup(
      createElement(ProviderGlyph, { provider: "datadog" }),
    );

    expect(markup).toContain(">DD</span>");
  });
});
