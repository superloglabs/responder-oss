import { describe, expect, it } from "vitest";
import {
  alertCreateSchema,
  alertFiringMessage,
  alertRecoveredMessage,
  alertTransition,
  describeAlertRule,
  evaluateAlert,
  worseValue,
} from "./alerts.js";

const projectId = "b925b1df-5b78-43c8-a816-6f00afb174af";
const errorLogs = {
  aggregation: "count" as const,
  comparator: "gt" as const,
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
      projectId,
      source: "metric",
      threshold: 1,
    });
    expect(parsed).toMatchObject({ enabled: true, evaluationIntervalSeconds: 60, slack: null, windowMinutes: 5 });
  });

  it("rejects inconsistent rules", () => {
    const base = { comparator: "gt", name: "x", projectId, threshold: 1 };
    for (const rule of [
      { ...base, aggregation: "sum", source: "logs" },
      { ...base, aggregation: "count", metricName: "m", source: "metric" },
      { ...base, aggregation: "avg", source: "metric" },
      { ...base, aggregation: "count", groupMode: "per_group", source: "traces" },
      { ...base, aggregation: "count", evaluationIntervalSeconds: 15, source: "logs" },
    ]) {
      expect(alertCreateSchema.safeParse(rule).success).toBe(false);
    }
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

  it("averages groups for an average rule and gives no evaluation without metric data", () => {
    const metric = { ...errorLogs, aggregation: "avg" as const, metricName: "cpu", source: "metric" as const };
    expect(evaluateAlert(metric, [{ group: "a", value: 40 }, { group: "b", value: 80 }], [])).toEqual([
      { breaching: true, groupKey: "", value: 60 },
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
    expect(firing.text).toBe("Checkout errors is firing for http.route /pay");
    expect(firing.markdown).toContain("**1,234.57**, above 50.");
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
