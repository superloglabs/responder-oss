import { describe, expect, it } from "vitest";
import type { SyntheticCheck } from "../db/synthetic-checks.js";
import type { TelemetryAlert } from "../db/telemetry-alerts.js";
import type { TelemetryDashboard } from "../db/telemetry-dashboards.js";
import { hclString, hclValue, terraformExport } from "./export.js";

const slack = { channelId: "C0123", integrationAccountId: "71717171-7171-4171-8171-717171717171" };

const alert: TelemetryAlert = {
  aggregation: "count",
  comparator: "gt",
  createdAt: "2026-10-28T10:00:00.000Z",
  enabled: true,
  evaluationIntervalSeconds: 60,
  field: null,
  filter: { resourceAttrs: [{ key: "deployment.environment", value: "prod" }], service: "checkout" },
  groupBy: null,
  groupMode: "single",
  id: "11111111-1111-4111-8111-111111111111",
  lastError: null,
  lastEvaluatedAt: null,
  metricName: null,
  name: "Checkout errors",
  slack,
  source: "logs",
  threshold: 50,
  updatedAt: "2026-10-28T10:00:00.000Z",
  windowMinutes: 10,
};

const dashboard: TelemetryDashboard = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Checkout",
  updatedAt: "2026-10-28T10:00:00.000Z",
  variables: [{ defaultValue: "prod", name: "env", options: ["prod", "staging"] }],
  widgets: [
    {
      config: {
        filter: { resourceAttrs: [{ key: "deployment.environment", value: "${env}" }] },
        groupBy: "service.name",
        source: "logs",
      },
      id: "33333333-3333-4333-8333-333333333333",
      layout: { h: 4, w: 6, x: 0, y: 0 },
      position: 0,
      title: "Errors by service",
      type: "timeseries_count",
    },
    {
      config: { filter: {}, markdown: "Runbook" },
      id: "44444444-4444-4444-8444-444444444444",
      layout: { h: 5, w: 4, x: 6, y: 0 },
      position: 1,
      title: "Notes",
      type: "markdown",
    },
  ],
};

const check: SyntheticCheck = {
  assertions: [
    { kind: "status_code", op: "eq", severity: "critical", value: "2xx" },
    { kind: "response_time", op: "lt", severity: "degraded", value: "1500" },
  ],
  body: null,
  consecutiveFailures: 0,
  createdAt: "2026-10-28T10:00:00.000Z",
  enabled: true,
  failuresToAlert: 1,
  followRedirects: true,
  headers: [
    { name: "Accept", secret: false, value: "application/json" },
    { name: "Authorization", secret: true, value: "" },
  ],
  id: "55555555-5555-4555-8555-555555555555",
  intervalSeconds: 60,
  lastRunAt: null,
  lastStatus: null,
  method: "GET",
  name: "Checkout errors",
  retries: 1,
  slack,
  statusSince: null,
  timeoutMs: 10_000,
  updatedAt: "2026-10-28T10:00:00.000Z",
  url: "https://api.example.com/health",
};

describe("terraform export", () => {
  it("escapes template sequences so values stay literal", () => {
    expect(hclString("${env} at 100%{x}")).toBe('"$${env} at 100%%{x}"');
    expect(hclString('say "hi"\n')).toBe('"say \\"hi\\"\\n"');
  });

  it("quotes object keys that are not identifiers", () => {
    expect(hclValue({ "resource.service": "a", ok: [1, 2] })).toBe(
      '{\n  "resource.service" = "a"\n  ok                 = [1, 2]\n}',
    );
  });

  it("writes each object with an import block and only non-default settings", () => {
    const hcl = terraformExport({
      alerts: [alert],
      checks: [check],
      dashboards: [dashboard],
      endpoint: "https://superlog.sh",
      slackChannels: [{ ...slack, accountName: "Acme", name: "alerts", private: false }],
    });

    expect(hcl).toContain('source = "superloglabs/superlog"');
    expect(hcl).toContain('endpoint = "https://superlog.sh"');
    expect(hcl).toContain('resource "superlog_alert" "checkout_errors" {');
    expect(hcl).toContain("window_minutes = 10");
    expect(hcl).not.toContain("evaluation_interval_seconds");
    expect(hcl).toContain('data "superlog_slack_channel" "alerts" {\n  name = "alerts"\n}');
    expect(hcl.match(/data "superlog_slack_channel"/gu)).toHaveLength(1);
    expect(hcl).toContain("channel_id             = data.superlog_slack_channel.alerts.channel_id");

    // Names are unique per resource type.
    expect(hcl).toContain('resource "superlog_synthetic_check" "checkout_errors" {');
    expect(hcl).toContain('import {\n  to = superlog_alert.checkout_errors\n  id = "11111111-1111-4111-8111-111111111111"\n}');
    expect(hcl).toContain('import {\n  to = superlog_synthetic_check.checkout_errors\n  id = "55555555-5555-4555-8555-555555555555"\n}');

    // Widget configs keep their variable references and drop empty filters.
    expect(hcl).toContain('value = "$${env}"');
    expect(hcl).toContain('config = jsonencode({\n        markdown = "Runbook"\n      })');
    expect(hcl).toContain("layout = { x = 6, y = 0, w = 4, h = 5 }");

    // Secret headers become sensitive variables.
    expect(hcl).toContain('variable "checkout_errors_authorization" {');
    expect(hcl).toContain('"Authorization" = var.checkout_errors_authorization');
    expect(hcl).toContain('severity = "degraded"');
    expect(hcl).not.toContain('severity = "critical"');
  });

  it("keeps Slack IDs for a channel that is no longer listed", () => {
    const hcl = terraformExport({ alerts: [alert], checks: [], dashboards: [], endpoint: "https://us.superlog.sh", slackChannels: [] });

    expect(hcl).toContain(`channel_id             = "C0123"`);
    expect(hcl).not.toContain("data \"superlog_slack_channel\"");
  });

  it("names resources whose names have no letters", () => {
    const hcl = terraformExport({
      alerts: [{ ...alert, name: "!!!" }, { ...alert, id: "66666666-6666-4666-8666-666666666666", name: "5xx rate" }],
      checks: [],
      dashboards: [],
      endpoint: "https://superlog.sh",
      slackChannels: [],
    });

    expect(hcl).toContain('resource "superlog_alert" "alert" {');
    expect(hcl).toContain('resource "superlog_alert" "_5xx_rate" {');
  });
});
