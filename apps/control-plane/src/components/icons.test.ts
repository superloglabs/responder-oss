import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProviderGlyph } from "./icons";

describe("ProviderGlyph", () => {
  it("announces the provider when the glyph carries meaning", () => {
    const markup = renderToStaticMarkup(
      createElement(ProviderGlyph, { label: "GitHub", text: "GH" }),
    );

    expect(markup).toContain('aria-label="GitHub"');
    expect(markup).toContain('role="img"');
    expect(markup).toContain(">GH</span>");
  });

  it("stays decorative when adjacent copy already names the provider", () => {
    const markup = renderToStaticMarkup(
      createElement(ProviderGlyph, {
        decorative: true,
        label: "Google",
        text: "GO",
      }),
    );

    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain("aria-label");
    expect(markup).not.toContain("role=");
  });
});
