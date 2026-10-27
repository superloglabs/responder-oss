import { describe, expect, it } from "vitest";
import { alertImageLayout } from "./telemetry-alert-message.js";

describe("alert image layout", () => {
  it("places the status and summary before the chart and the link after it", () => {
    const result = alertImageLayout({
      alertName: "Worker errors", alertUrl: "https://example.com/alerts/1", groupBy: "responder.cell", groupKey: "eu",
      rule: { aggregation: "count", comparator: "gt", threshold: 0, field: null, filter: { service: "responder-worker", severity: "error" }, metricName: null, source: "logs", windowMinutes: 5 }, value: 1,
    });
    expect(result.before).toEqual([
      { type: "context", elements: [{ type: "mrkdwn", text: ":red_circle: *Firing*   responder.\u200bcell: eu" }] },
      { type: "markdown", text: "**Worker errors**\n\n1 error from responder-worker in the last 5 minutes." },
    ]);
    expect(result.after).toEqual([{ type: "markdown", text: "[View alert](https://example.com/alerts/1)" }]);
  });
});
