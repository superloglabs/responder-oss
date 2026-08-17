import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProviderGlyph } from "./icons";

describe("ProviderGlyph", () => {
  it.each([
    ["clickstack", "ClickStack", "CS"],
    ["datadog", "Datadog", "DD"],
    ["github", "GitHub", "GH"],
    ["linear", "Linear", "LI"],
    ["sentry", "Sentry", "SE"],
    ["slack", "Slack", "SL"],
  ] as const)(
    "renders the %s logo and announces the provider",
    (provider, label, text) => {
      const markup = renderToStaticMarkup(
        createElement(ProviderGlyph, { provider }),
      );

      expect(markup).toContain(`aria-label="${label}"`);
      expect(markup).toContain('role="img"');
      expect(markup).toContain("<svg");
      expect(markup).not.toContain(`>${text}</span>`);
    },
  );

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

  it("keeps a text glyph for custom MCP servers", () => {
    const markup = renderToStaticMarkup(
      createElement(ProviderGlyph, { provider: "custom_mcp" }),
    );

    expect(markup).toContain(">MCP</span>");
    expect(markup).not.toContain("<svg");
  });
});
