import { describe, expect, it } from "vitest";
import { alertForm, alertRequest, emptyAlertForm, type TelemetryAlert } from "./alerts-api";

const projectId = "b925b1df-5b78-43c8-a816-6f00afb174af";
const accountId = "22222222-2222-4222-8222-222222222222";

describe("alertRequest", () => {
  it("builds an error-log rule posting to a channel", () => {
    expect(
      alertRequest({
        ...emptyAlertForm(projectId),
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
        filter: {
          resourceAttrs: [{ key: "deployment.environment", value: "production" }],
          service: "checkout",
          severity: "ERROR",
        },
        groupBy: null,
        groupMode: "single",
        metricName: null,
        name: "Checkout errors",
        projectId,
        slack: { channelId: "C123", integrationAccountId: accountId },
        source: "logs",
        threshold: 50,
        windowMinutes: 5,
      },
    });
  });

  it("averages a metric by default and counts spans with errors", () => {
    const metric = alertRequest({ ...emptyAlertForm(projectId), metricName: "cpu", name: "CPU", source: "metric", threshold: "0.9" });
    expect(metric).toMatchObject({ body: { aggregation: "avg", filter: {}, metricName: "cpu" } });
    const spans = alertRequest({ ...emptyAlertForm(projectId), name: "Errors", source: "traces", threshold: "1" });
    expect(spans).toMatchObject({ body: { aggregation: "count", filter: { statusCode: "STATUS_CODE_ERROR" } } });
  });

  it("says what to fix first", () => {
    expect(alertRequest({ ...emptyAlertForm(projectId), threshold: "1" })).toEqual({ error: "Name the alert." });
    expect(alertRequest({ ...emptyAlertForm(projectId), name: "x", threshold: "" })).toEqual({ error: "Set a threshold." });
    expect(alertRequest({ ...emptyAlertForm(projectId), name: "x", threshold: "abc" })).toEqual({ error: "Set a threshold." });
    expect(alertRequest({ ...emptyAlertForm(projectId), name: "x", source: "metric", threshold: "1" })).toEqual({ error: "Choose a metric." });
    expect(alertRequest({ ...emptyAlertForm(projectId), name: "x", perGroup: true, threshold: "1" })).toEqual({
      error: "Choose what to group by.",
    });
  });
});

describe("alertForm", () => {
  it("keeps a span status other than error", () => {
    const form = { ...emptyAlertForm(projectId), extraFilter: { statusCode: "STATUS_CODE_OK" }, name: "OK spans", source: "traces" as const, spanErrors: false, threshold: "1" };
    expect(alertRequest(form)).toMatchObject({ body: { filter: { statusCode: "STATUS_CODE_OK" } } });
    expect(alertRequest({ ...form, spanErrors: true })).toMatchObject({ body: { filter: { statusCode: "STATUS_CODE_ERROR" } } });
  });

  it("round-trips a copied Superlog alert, keeping filters the form does not edit", () => {
    const alert: TelemetryAlert = {
      aggregation: "count",
      comparator: "lt",
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
      projectId,
      projectName: "Shop",
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
        filter: alert.filter,
        groupBy: "service",
        groupMode: "per_group",
        metricName: null,
        name: "Slow order errors",
        projectId,
        slack: alert.slack,
        source: "traces",
        threshold: 2,
        windowMinutes: 15,
      },
    });
  });
});
