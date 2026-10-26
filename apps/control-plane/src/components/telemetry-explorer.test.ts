import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExplorerFacet } from "./telemetry-explorer";

describe("facet gauges", () => {
  it("keeps absent selected values selectable without inventing a count", () => {
    const html = renderToStaticMarkup(createElement(ExplorerFacet, {
      gauges: true, loading: false, onToggle: () => {}, selected: ["absent"], title: "Service",
      options: [{ label: "api", value: "api", count: 0 }],
    }));
    expect(html).toContain("0 · 0.0%");
    expect(html).not.toMatch(/NaN|Infinity/);
    expect(html).toContain('checked=""');
    expect(html).toContain("absent");
    expect(html.match(/explorerFacet__gauge/g)).toHaveLength(1);
  });
  it("leaves gauges out of existing non-log facets", () => {
    const html = renderToStaticMarkup(createElement(ExplorerFacet, {
      loading: false, onToggle: () => {}, selected: [], title: "Service",
      options: [{ label: "api", value: "api", count: 10 }],
    }));
    expect(html).not.toContain("explorerFacet__gauge");
    expect(html).not.toContain("100.0%");
  });
});
