import { describe, expect, it, vi } from "vitest";
import { alertSeries } from "@responder/core/telemetry/alert-series";
import type { AlertRule } from "@responder/core/telemetry/alerts";
import { alertChartSvg, renderAlertChart } from "./telemetry-alert-chart.js";

vi.mock("@responder/core/telemetry/alert-series", () => ({ chartWindows: 24, alertSeries: vi.fn() }));
const now = new Date("2026-10-27T09:20:00Z");
const rule: AlertRule & { name: string } = {
  aggregation: "count", comparator: "gt", field: null, filter: {}, groupBy: "resource.cell", groupMode: "per_group",
  metricName: null, name: "Worker errors", source: "logs", threshold: 0, windowMinutes: 5,
};

describe("alert evaluation graph", () => {
  it("queries only the firing group and renders a PNG without system fonts", async () => {
    vi.mocked(alertSeries).mockResolvedValue([{ bucket: "2026-10-27 09:15:00", group: "eu", value: 1 }]);
    const image = await renderAlertChart({ client: {} as never, groupKey: "eu", now, organizationId: "org-1", rule });
    expect(alertSeries).toHaveBeenCalledWith({}, "org-1", rule, now, { since: "2026-10-27T07:20:00.000Z", until: now.toISOString() }, "eu");
    expect(image.png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(image.png.readUInt32BE(16)).toBe(1024);
    expect(image.png.readUInt32BE(20)).toBe(416);
    expect(image.altText).toContain("eu. Alert when above 0");
  });

  it("escapes labels and keeps missing measurements as gaps", () => {
    const svg = alertChartSvg({
      chart: { buckets: [now.getTime() - 600_000, now.getTime() - 300_000, now.getTime()], series: [{ name: "eu", other: false, values: [1, null, 3] }], stepMs: 300_000 },
      groupKey: '<image href="https://example.com"/>', now, rule: { ...rule, name: "A & B <errors>" },
    });
    expect(svg).toContain("Logs per 5 minutes");
    expect(svg).not.toContain('<image href=');
    expect(svg).not.toContain("<path");
    expect(svg).not.toContain("<circle");
    expect(svg).not.toContain("Current");
    // The missing bucket and the bucket starting at the exclusive end are omitted.
    expect(svg.match(/rx="1"/g)).toHaveLength(1);
    expect(svg).not.toMatch(/NaN|Infinity/);
  });

  it("leaves zero buckets empty so they do not paint over the threshold", () => {
    const svg = alertChartSvg({
      chart: { buckets: [now.getTime() - 600_000, now.getTime() - 300_000], series: [{ name: "eu", other: false, values: [0, 1] }], stepMs: 300_000 },
      groupKey: "eu", now, rule,
    });
    // Only the nonzero interval draws a bar.
    expect(svg.match(/rx="1"/g)).toHaveLength(1);
    expect(svg).not.toContain('height="1"');
  });

});
