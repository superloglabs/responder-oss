import { describe, expect, it } from "vitest";
import {
  alertCreateSchema,
  alertFiringMessage,
  alertRecoveredMessage,
  alertTransition,
  describeAlertRule,
  evaluateAlert,
  formatAlertValue,
  worseValue,
} from "./alerts.js";
import { alertValueUnit } from "./alert-text.js";

const errorLogs = {
  aggregation: "count" as const,
  comparator: "gt" as const,
  field: null,
  filter: { severity: "error", service: "checkout" },
  groupBy: null,
  groupMode: "single" as const,
  metricName: null,
  source: "logs" as const,
  threshold: 50,
  windowMinutes: 5,
};

describe("alert rules", () => {
  it("accepts a Superlog alert as stored, with defaults", () => {
    const parsed = alertCreateSchema.parse({
      aggregation: "avg",
      comparator: "lt",
      filter: { resourceAttrs: [{ key: "deployment.environment", value: "production" }] },
      groupBy: "service.name",
      groupMode: "per_group",
      metricName: "queue.depth",
      name: "Queue drained",
      source: "metric",
      threshold: 1,
    });
    expect(parsed).toMatchObject({ enabled: true, evaluationIntervalSeconds: 60, slack: null, windowMinutes: 5 });
  });

  it("rejects inconsistent rules", () => {
    const base = { comparator: "gt", name: "x", threshold: 1 };
    for (const rule of [
      { ...base, aggregation: "sum", source: "logs" },
      { ...base, aggregation: "count", metricName: "m", source: "metric" },
      { ...base, aggregation: "avg", source: "metric" },
      { ...base, aggregation: "count", groupMode: "per_group", source: "traces" },
      { ...base, aggregation: "count", evaluationIntervalSeconds: 15, source: "logs" },
      { ...base, aggregation: "sum", field: "ai:cost", source: "logs" },
      { ...base, aggregation: "count_distinct", field: "ai:cost", source: "traces" },
      { ...base, aggregation: "p95", field: "duration", source: "logs" },
      { ...base, aggregation: "p95", metricName: "m", source: "metric" },
    ]) {
      expect(alertCreateSchema.safeParse(rule).success).toBe(false);
    }
  });

  it("aggregates a span field such as AI cost", () => {
    const rule = { aggregation: "sum", comparator: "gt", field: "ai:cost", groupBy: "ai:model", groupMode: "per_group", name: "AI spend", source: "traces", threshold: 50, windowMinutes: 60 };
    expect(alertCreateSchema.safeParse(rule).success).toBe(true);
    expect(alertCreateSchema.safeParse({ ...rule, aggregation: "p99", field: "duration" }).success).toBe(true);
    expect(alertCreateSchema.parse({ comparator: "gt", aggregation: "count", name: "x", source: "logs", threshold: 1 }).field).toBeNull();
  });
});

describe("evaluateAlert", () => {
  it("totals a single rule, and counts no rows as zero", () => {
    expect(evaluateAlert(errorLogs, [{ group: "", value: 51 }], [])).toEqual([
      { breaching: true, groupKey: "", value: 51 },
    ]);
    expect(evaluateAlert({ ...errorLogs, comparator: "lt", threshold: 1 }, [], [])).toEqual([
      { breaching: true, groupKey: "", value: 0 },
    ]);
  });

  it("takes a metric total as queried, and gives no evaluation without metric data", () => {
    // The store averages every data point of an ungrouped total.
    const metric = { ...errorLogs, aggregation: "avg" as const, metricName: "cpu", source: "metric" as const };
    expect(evaluateAlert(metric, [{ group: "", value: 72.5 }], [])).toEqual([
      { breaching: true, groupKey: "", value: 72.5 },
    ]);
    expect(evaluateAlert(metric, [], [""])).toEqual([]);
  });

  it("evaluates each group, and ends a counted group that stopped reporting", () => {
    const perService = { ...errorLogs, groupBy: "service", groupMode: "per_group" as const };
    expect(evaluateAlert(perService, [{ group: "api", value: 70 }, { group: "web", value: 2 }], ["worker"])).toEqual([
      { breaching: true, groupKey: "api", value: 70 },
      { breaching: false, groupKey: "web", value: 2 },
      { breaching: false, groupKey: "worker", value: 0 },
    ]);
    const perHost = { ...perService, aggregation: "avg" as const, metricName: "cpu", source: "metric" as const };
    expect(evaluateAlert(perHost, [], ["host-1"])).toEqual([]);
  });
});

describe("evaluating field aggregations", () => {
  const cost = { aggregation: "sum" as const, comparator: "gt" as const, groupBy: null, groupMode: "single" as const, source: "traces" as const, threshold: 50 };

  it("reads a sum with no calls as zero, and an average with no calls as no value", () => {
    expect(evaluateAlert(cost, [], [])).toEqual([{ breaching: false, groupKey: "", value: 0 }]);
    expect(evaluateAlert({ ...cost, aggregation: "avg" }, [], [])).toEqual([]);
    expect(evaluateAlert({ ...cost, aggregation: "p95" }, [{ group: "", value: 60 }], [])).toEqual([
      { breaching: true, groupKey: "", value: 60 },
    ]);
  });

  it("ends a model's cost episode when it stops being called, but not a percentile's", () => {
    const perModel = { ...cost, groupBy: "ai:model", groupMode: "per_group" as const };
    expect(evaluateAlert(perModel, [], ["gpt-5"])).toEqual([{ breaching: false, groupKey: "gpt-5", value: 0 }]);
    expect(evaluateAlert({ ...perModel, aggregation: "p95" }, [], ["gpt-5"])).toEqual([]);
  });
});

describe("alertTransition", () => {
  it("opens, continues and ends episodes", () => {
    expect(alertTransition(true, false)).toBe("opened");
    expect(alertTransition(true, true)).toBe("continued");
    expect(alertTransition(false, true)).toBe("recovered");
    expect(alertTransition(false, false)).toBeNull();
    expect(worseValue("gt", 3, 5)).toBe(5);
    expect(worseValue("lt", 3, 5)).toBe(3);
  });
});

describe("alert messages", () => {
  it("describes the rule, value and condition", () => {
    expect(describeAlertRule({ ...errorLogs, windowMinutes: 60 })).toBe("ERROR logs from checkout in the last hour");
    const firing = alertFiringMessage({
      alertName: "Checkout errors",
      alertUrl: "https://us.superlog.sh/alerts/1",
      groupBy: "attr:http.route",
      groupKey: "/pay",
      rule: errorLogs,
      value: 1234.567,
    });
    // Zero-width spaces keep Slack from linking dotted values; they are invisible.
    expect(firing.text.replaceAll("\u200b", "")).toBe("Checkout errors is firing for http.route /pay");
    expect(firing.markdown).toContain("**1,234.57**, above 50.");
    expect(firing.markdown).toContain("[View alert](https://us.superlog.sh/alerts/1)");
  });

  it("describes AI cost in dollars", () => {
    const cost = { ...errorLogs, aggregation: "sum" as const, field: "ai:cost", filter: {}, source: "traces" as const, windowMinutes: 60 };
    expect(describeAlertRule(cost)).toBe("Sum of AI cost in the last hour");
    expect(describeAlertRule({ ...cost, aggregation: "p95", field: "duration" })).toBe("95th percentile of span duration over spans in the last hour");
    const firing = alertFiringMessage({
      alertName: "AI spend",
      alertUrl: null,
      groupBy: "ai:model",
      groupKey: "gpt-5",
      rule: { ...cost, threshold: 50 },
      value: 61.234,
    });
    expect(firing.markdown).toContain("Sum of AI cost in the last hour: **$61.23**, above $50.00.");
    expect(firing.text.replaceAll("\u200b", "")).toBe("AI spend is firing for model gpt-5");
    expect(alertValueUnit(cost)).toBe("usd");
    expect(formatAlertValue(0.0042, "usd")).toBe("$0.0042");
    expect(formatAlertValue(0.1, "usd")).toBe("$0.10");
    expect(alertValueUnit({ ...cost, aggregation: "count_distinct" })).toBe("none");
  });

  it("keeps names and group values from mentioning or formatting", () => {
    const firing = alertFiringMessage({
      alertName: "<!channel> *urgent*",
      alertUrl: null,
      groupBy: "user_agent",
      groupKey: "<@U123> `x`",
      rule: errorLogs,
      value: 51,
    });
    expect(firing.markdown).toContain("**&lt;!channel&gt; \\*urgent\\***");
    expect(firing.markdown).toContain("for user\\_agent &lt;@U123&gt; \\`x\\`");
    expect(firing.text).not.toMatch(/<!channel>|<@U123>/u);
  });

  it("keeps backslashes from undoing escapes, and URLs from linking", () => {
    const firing = alertFiringMessage({
      alertName: "\\*bold\\* https://evil.example",
      alertUrl: "https://us.superlog.sh/alerts/1",
      groupBy: null,
      groupKey: "",
      rule: errorLogs,
      value: 51,
    });
    expect(firing.markdown).toContain("\\\\\\*bold\\\\\\*");
    expect(firing.markdown).not.toContain("https://evil.example");
    expect(firing.markdown).toContain("https:\u200b//evil.\u200bexample");
    // The app's own link is not altered.
    expect(firing.markdown).toContain("[View alert](https://us.superlog.sh/alerts/1)");
  });

  it("says how long the alert fired", () => {
    const recovered = alertRecoveredMessage({
      alertName: "Checkout errors",
      alertUrl: null,
      firingForMs: 95 * 60_000,
      groupBy: null,
      groupKey: "",
      rule: errorLogs,
      value: 3,
    });
    expect(recovered.markdown).toBe(
      ":white_check_mark: **Checkout errors** recovered after 1 hour 35 minutes. The value is **3**, at or below 50.",
    );
  });
});
