import { describe, expect, it } from "vitest";
import {
  alertForm,
  alertMetricChoice,
  alertMetricOptions,
  alertMetricValue,
  alertRequest,
  emptyAlertForm,
  type TelemetryAlert,
} from "./alerts-api";

const accountId = "22222222-2222-4222-8222-222222222222";

describe("alertRequest", () => {
  it("builds an error-log rule posting to a channel", () => {
    expect(
      alertRequest({
        ...emptyAlertForm(),
        filters: [{ key: "deployment.environment", value: "production" }, { key: " ", value: "ignored" }],
        name: " Checkout errors ",
        service: "checkout",
        slack: `${accountId}:C123`,
        threshold: "50",
      }),
    ).toEqual({
      body: {
        aggregation: "count",
        comparator: "gt",
        enabled: true,
        evaluationIntervalSeconds: 60,
        field: null,
        filter: {
          resourceAttrs: [{ key: "deployment.environment", value: "production" }],
          service: "checkout",
          severity: "ERROR",
        },
        groupBy: null,
        groupMode: "single",
        metricName: null,
        name: "Checkout errors",
        slack: { channelId: "C123", integrationAccountId: accountId },
        source: "logs",
        threshold: 50,
        windowMinutes: 5,
      },
    });
  });

  it("averages a metric by default and counts spans with errors", () => {
    const metric = alertRequest({ ...emptyAlertForm(), metricName: "cpu", name: "CPU", source: "metric", threshold: "0.9" });
    expect(metric).toMatchObject({ body: { aggregation: "avg", filter: {}, metricName: "cpu" } });
    const spans = alertRequest({ ...emptyAlertForm(), name: "Errors", source: "traces", threshold: "1" });
    expect(spans).toMatchObject({ body: { aggregation: "count", filter: { statusCode: "STATUS_CODE_ERROR" } } });
  });

  it("keeps the metric's kind and unit, and drops them for other sources", () => {
    const form = {
      ...emptyAlertForm(),
      metricKind: "histogram" as const,
      metricName: "rpc.duration",
      metricUnit: "ms",
      name: "Slow RPCs",
      source: "metric" as const,
      threshold: "250",
    };
    expect(alertRequest(form)).toMatchObject({ body: { filter: { metricKind: "histogram", metricUnit: "ms" } } });
    const logs = alertRequest({ ...form, source: "logs" });
    expect("body" in logs && logs.body.filter).toEqual({ severity: "ERROR" });
  });

  it("says what to fix first", () => {
    expect(alertRequest({ ...emptyAlertForm(), threshold: "1" })).toEqual({ error: "Name the alert." });
    expect(alertRequest({ ...emptyAlertForm(), name: "x", threshold: "" })).toEqual({ error: "Set a threshold." });
    expect(alertRequest({ ...emptyAlertForm(), name: "x", threshold: "abc" })).toEqual({ error: "Set a threshold." });
    expect(alertRequest({ ...emptyAlertForm(), name: "x", source: "metric", threshold: "1" })).toEqual({ error: "Choose a metric." });
    expect(alertRequest({ ...emptyAlertForm(), name: "x", perGroup: true, threshold: "1" })).toEqual({
      error: "Choose what to group by.",
    });
  });
});

describe("choosing an alert's metric", () => {
  it("picks one metric when a name is sent as several kinds or units", () => {
    const options = alertMetricOptions([
      { kind: "histogram", name: "rpc.duration", unit: "ms" },
      { kind: "gauge", name: "rpc.duration", unit: "s" },
      { kind: "sum", name: "jobs", unit: "" },
    ]);

    expect(options.map((option) => option.label)).toEqual(["rpc.duration (ms)", "rpc.duration (s)", "jobs"]);
    expect(new Set(options.map((option) => option.value)).size).toBe(3);
    expect(alertMetricChoice(options[1]!.value)).toEqual({ metricKind: "gauge", metricName: "rpc.duration", metricUnit: "s" });
    expect(alertMetricChoice(options[2]!.value)).toEqual({ metricKind: "sum", metricName: "jobs", metricUnit: "" });
  });

  it("names the kind of metrics that share a name and unit", () => {
    const options = alertMetricOptions([
      { kind: "gauge", name: "queue.size", unit: "" },
      { kind: "sum", name: "queue.size", unit: "" },
      { kind: "gauge", name: "cpu", unit: "%" },
    ]);

    expect(options.map((option) => option.label)).toEqual(["queue.size · Gauge", "queue.size · Sum", "cpu (%)"]);
  });

  it("keeps an alert's metric selected, with or without its kind and unit", () => {
    const options = alertMetricOptions([{ kind: "gauge", name: "rpc.duration", unit: "s" }]);
    const chosen = { metricKind: "gauge" as const, metricName: "rpc.duration", metricUnit: "s" };

    expect(alertMetricValue(chosen)).toBe(options[0]!.value);
    const byName = { metricKind: "" as const, metricName: "rpc.duration", metricUnit: null };
    expect(alertMetricChoice(alertMetricValue(byName))).toEqual(byName);
  });
});

describe("alertForm", () => {
  it("keeps a span status other than error", () => {
    const form = { ...emptyAlertForm(), extraFilter: { statusCode: "STATUS_CODE_OK" }, name: "OK spans", source: "traces" as const, spanErrors: false, threshold: "1" };
    expect(alertRequest(form)).toMatchObject({ body: { filter: { statusCode: "STATUS_CODE_OK" } } });
    expect(alertRequest({ ...form, spanErrors: true })).toMatchObject({ body: { filter: { statusCode: "STATUS_CODE_ERROR" } } });
  });

  it("round-trips a copied Superlog alert, keeping filters the form does not edit", () => {
    const alert: TelemetryAlert = {
      aggregation: "count",
      comparator: "lt",
      field: null,
      createdAt: "",
      enabled: false,
      evaluationIntervalSeconds: 300,
      filter: { minDurationMs: 500, service: "api", spanName: "GET /orders", statusCode: "STATUS_CODE_ERROR" },
      groupBy: "service",
      groupMode: "per_group",
      id: "a",
      lastError: null,
      lastEvaluatedAt: null,
      metricName: null,
      name: "Slow order errors",
      slack: { channelId: "C1", integrationAccountId: accountId },
      source: "traces",
      threshold: 2,
      updatedAt: "",
      windowMinutes: 15,
    };
    const request = alertRequest(alertForm(alert));
    expect(request).toEqual({
      body: {
        aggregation: "count",
        comparator: "lt",
        enabled: false,
        evaluationIntervalSeconds: 300,
        field: null,
        filter: alert.filter,
        groupBy: "service",
        groupMode: "per_group",
        metricName: null,
        name: "Slow order errors",
        slack: alert.slack,
        source: "traces",
        threshold: 2,
        windowMinutes: 15,
      },
    });
  });
});

describe("AI cost alerts", () => {
  it("builds a cost rule over spans and needs a field for it", () => {
    const form = {
      ...emptyAlertForm(),
      aggregation: "sum" as const,
      field: "ai:cost",
      groupBy: "ai:model",
      name: "AI spend",
      perGroup: true,
      source: "traces" as const,
      spanErrors: false,
      threshold: "50",
      windowMinutes: 60,
    };
    const request = alertRequest(form);
    expect(request).toMatchObject({
      body: { aggregation: "sum", field: "ai:cost", groupBy: "ai:model", groupMode: "per_group", source: "traces", threshold: 50 },
    });
    expect("body" in request && request.body.filter).toEqual({});
    expect(alertRequest({ ...form, field: "" })).toEqual({ error: "Choose a field to aggregate." });
    expect(alertRequest({ ...form, aggregation: "count" })).toMatchObject({ body: { aggregation: "count", field: null } });
  });
});
