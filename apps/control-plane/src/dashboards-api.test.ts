import { describe, expect, it } from "vitest";
import {
  axisTicks,
  changedLayouts,
  defaultVariableValues,
  formatWidgetValue,
  placeWidget,
  suggestedWidgetTitle,
} from "./dashboards-api";

describe("formatWidgetValue", () => {
  it("formats each unit", () => {
    expect(formatWidgetValue(1234.5678)).toBe("1,234.568");
    expect(formatWidgetValue(2_500_000)).toBe("2.5M");
    expect(formatWidgetValue(1500, "duration_ms")).toBe("1.5 s");
    expect(formatWidgetValue(0.25, "duration_s")).toBe("250 ms");
    expect(formatWidgetValue(1536, "bytes")).toBe("1.5 KB");
    expect(formatWidgetValue(512, "bytes")).toBe("512 B");
    expect(formatWidgetValue(42, "percent")).toBe("42%");
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

describe("suggestedWidgetTitle", () => {
  it("describes the widget", () => {
    expect(suggestedWidgetTitle({ config: { filter: {} }, type: "timeseries_count" })).toBe("Logs");
    expect(
      suggestedWidgetTitle({ config: { aggregation: "p99", filter: {}, metricName: "rpc.duration" }, type: "timeseries_metric" }),
    ).toBe("rpc.duration (p99)");
    expect(suggestedWidgetTitle({ config: { filter: {}, markdown: "no heading" }, type: "markdown" })).toBe("Note");
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
