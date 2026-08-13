import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InvestigationThinking } from "./investigation-thinking";

describe("InvestigationThinking", () => {
  it("renders a dynamic nine-cell progress indicator with elapsed time", () => {
    const markup = renderToStaticMarkup(createElement(InvestigationThinking));

    expect(markup.match(/class="investigationThinking__dot/g)).toHaveLength(9);
    expect(markup).toContain("Churning");
    expect(markup).toContain("0.0s");
    expect(markup).toContain(
      "Investigation in progress. This page refreshes automatically.",
    );
  });

  it("supports circular dot and orbit variants", () => {
    const dots = renderToStaticMarkup(
      createElement(InvestigationThinking, { variant: "Dots" }),
    );
    const orbit = renderToStaticMarkup(
      createElement(InvestigationThinking, { variant: "Orbit" }),
    );

    expect(dots.match(/investigationThinking__dot--round/g)).toHaveLength(9);
    expect(orbit).toContain("animation:none;opacity:0.07");
  });
});
