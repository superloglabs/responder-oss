import { describe, expect, it } from "vitest";
import {
  axisTicks,
  changedLayouts,
  defaultVariableValues,
  formatWidgetValue,
  nextVariableValues,
  variableControl,
  variableFilters,
  variableParams,
  variablesFromRows,
  variableValuesFromParams,
  placeWidget,
  suggestedWidgetTitle,
} from "./dashboards-api";

describe("formatWidgetValue", () => {
  it("formats each unit", () => {
    // Plain numbers follow the reader's locale.
    expect(formatWidgetValue(1234.5678)).toBe(new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(1234.5678));
    expect(formatWidgetValue(2_500_000)).toBe(
      new Intl.NumberFormat(undefined, { maximumFractionDigits: 1, notation: "compact" }).format(2_500_000),
    );
    expect(formatWidgetValue(1500, "duration_ms")).toBe("1.5 s");
    expect(formatWidgetValue(0.25, "duration_s")).toBe("250 ms");
    expect(formatWidgetValue(1536, "bytes")).toBe("1.5 KB");
    expect(formatWidgetValue(512, "bytes")).toBe("512 B");
    expect(formatWidgetValue(42, "percent")).toBe(`${new Intl.NumberFormat().format(42)}%`);
    expect(formatWidgetValue(null)).toBe("—");
  });
});

describe("axisTicks", () => {
  it("starts at zero and covers the highest value with round steps", () => {
    expect(axisTicks(0, 87)).toEqual([0, 25, 50, 75, 100]);
    expect(axisTicks(0, 0)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(axisTicks(-10, 30)).toEqual([-10, 0, 10, 20, 30]);
  });
});

describe("changedLayouts", () => {
  it("returns only widgets that moved or resized", () => {
    expect(
      changedLayouts(
        [
          { id: "a", layout: { h: 4, w: 6, x: 0, y: 0 } },
          { id: "b", layout: { h: 4, w: 6, x: 6, y: 0 } },
        ],
        [
          { h: 4, i: "a", w: 6, x: 0, y: 0 },
          { h: 5, i: "b", w: 6, x: 6, y: 0 },
          { h: 1, i: "unknown", w: 1, x: 0, y: 0 },
        ],
      ),
    ).toEqual([{ id: "b", layout: { h: 5, w: 6, x: 6, y: 0 } }]);
  });
});

describe("dashboard variables", () => {
  it("defaults to the default value, then the first option, then empty", () => {
    expect(
      defaultVariableValues([
        { defaultValue: "staging", name: "env", options: ["production", "staging"] },
        { name: "region", options: ["eu", "us"] },
        { name: "free", options: [] },
      ]),
    ).toEqual({ env: "staging", free: "", region: "eu" });
  });
});

describe("nextVariableValues", () => {
  it("keeps a selection only while the variable still allows it", () => {
    expect(
      nextVariableValues(
        [
          { defaultValue: "production", name: "env", options: ["production", "staging"] },
          { name: "region", options: ["eu"] },
          { name: "free", options: [] },
          { name: "added", options: ["a", "b"] },
        ],
        { env: "staging", free: "typed", gone: "x", region: "us" },
      ),
    ).toEqual({ added: "a", env: "staging", free: "typed", region: "eu" });
  });
});

describe("multi-value variables", () => {
  const variables = [
    { attributeKey: "service.name", name: "service", options: [] },
    { attributeKey: "http.route", multi: true, name: "route", options: [] },
    { attributeKey: "cloud.region", defaultValue: "eu-west-3", multi: true, name: "region", options: ["eu-west-3", "us-east-1"] },
  ];

  it("starts with the default selected, or nothing, which matches every value", () => {
    expect(defaultVariableValues(variables)).toEqual({ region: ["eu-west-3"], route: [], service: "" });
  });

  it("keeps selections the variable still allows", () => {
    expect(nextVariableValues(variables, { region: ["us-east-1", "ap-south-1"], route: "POST /checkout", service: ["api"] })).toEqual({
      region: ["us-east-1"],
      route: ["POST /checkout"],
      service: "api",
    });
    expect(nextVariableValues(variables, { region: [] })).toMatchObject({ region: [] });
  });

  it("round-trips selections through the URL", () => {
    const values = { region: [], route: ["POST /checkout", "POST /refunds"], service: "checkout" };
    const params = variableParams(values, new URLSearchParams("range=1h&var-old=x"));
    expect(params.get("range")).toBe("1h");
    expect(params.has("var-old")).toBe(false);
    expect(variableValuesFromParams(variables, params)).toEqual(values);
    expect(variableValuesFromParams(variables, new URLSearchParams())).toEqual(defaultVariableValues(variables));
  });

  it("filters one variable's values by the others' selections", () => {
    expect(variableFilters(variables, { region: [], route: ["a", "b"], service: "checkout" }, "region")).toEqual({
      filters: [
        { key: "service.name", value: "checkout" },
        { key: "http.route", value: "a", values: ["a", "b"] },
      ],
      names: ["service", "route"],
    });
  });

  it("lists values for a variable with options, an attribute, or several values, and types the rest", () => {
    expect(variableControl({ name: "a", options: ["x"] })).toBe("list");
    expect(variableControl({ attributeKey: "k", name: "a", options: [] })).toBe("list");
    expect(variableControl({ multi: true, name: "a", options: [] })).toBe("list");
    expect(variableControl({ name: "a", options: [] })).toBe("typed");
  });

  it("saves the several-values choice from the editor", () => {
    expect(
      variablesFromRows([{ attributeKey: "http.route", defaultValue: "", label: "", multi: true, name: "route", options: "" }]),
    ).toEqual({ variables: [{ attributeKey: "http.route", multi: true, name: "route", options: [] }] });
  });
});

describe("suggestedWidgetTitle", () => {
  it("describes the widget", () => {
    expect(suggestedWidgetTitle({ config: { filter: {} }, type: "timeseries_count" })).toBe("Logs");
    expect(
      suggestedWidgetTitle({ config: { aggregation: "p99", filter: {}, metricName: "rpc.duration" }, type: "timeseries_metric" }),
    ).toBe("rpc.duration (p99)");
    expect(suggestedWidgetTitle({ config: { filter: {}, markdown: "no heading" }, type: "markdown" })).toBe("Note");
    expect(suggestedWidgetTitle({ config: { filter: {}, markdown: "#\nbody" }, type: "markdown" })).toBe("Note");
  });
});

describe("placeWidget", () => {
  it("fills the space beside a half-width chart, then goes below", () => {
    expect(placeWidget("timeseries_count", [])).toEqual({ h: 4, w: 6, x: 0, y: 0 });
    expect(placeWidget("timeseries_metric", [{ h: 4, w: 6, x: 0, y: 0 }])).toEqual({ h: 4, w: 6, x: 6, y: 0 });
    expect(
      placeWidget("log_table", [
        { h: 4, w: 6, x: 0, y: 0 },
        { h: 5, w: 6, x: 6, y: 0 },
      ]),
    ).toEqual({ h: 6, w: 12, x: 0, y: 5 });
  });
});
