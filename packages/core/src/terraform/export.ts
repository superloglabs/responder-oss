import type { SyntheticCheck } from "../db/synthetic-checks.js";
import type { TelemetryAlert, TelemetryAlertSlackChannel } from "../db/telemetry-alerts.js";
import type { TelemetryDashboard } from "../db/telemetry-dashboards.js";

// Terraform configuration for a workspace's alerts, dashboards, and
// synthetic checks, for the superloglabs/superlog provider. Each resource
// comes with an import block, so applying it adopts the existing objects
// instead of creating copies.

export type TerraformExportInput = {
  alerts: readonly TelemetryAlert[];
  checks: readonly SyntheticCheck[];
  dashboards: readonly TelemetryDashboard[];
  // The workspace's cell, such as https://superlog.sh.
  endpoint: string;
  slackChannels: readonly TelemetryAlertSlackChannel[];
};

type Slack = { channelId: string; integrationAccountId: string } | null;

const identifierPattern = /^[A-Za-z_][A-Za-z0-9_-]*$/u;

// A quoted HCL string. Template sequences are escaped so values such as a
// dashboard's `${env}` stay literal.
export function hclString(value: string): string {
  return JSON.stringify(value).replace(/([$%])\{/gu, (_match, sign: string) => `${sign}${sign}{`);
}

function hclKey(key: string): string {
  return identifierPattern.test(key) ? key : hclString(key);
}

const indentation = (depth: number) => "  ".repeat(depth);

// Attribute lines aligned as `terraform fmt` aligns them: runs of one-line
// values share the width of their longest key, and a value that spans
// lines is not padded and ends the run.
function alignedLines(entries: ReadonlyArray<readonly [string, string]>, depth: number): string[] {
  const lines: string[] = [];
  let run: Array<readonly [string, string]> = [];
  const flush = () => {
    const width = Math.max(0, ...run.map(([key]) => key.length));
    for (const [key, text] of run) lines.push(`${indentation(depth)}${key.padEnd(width)} = ${text}`);
    run = [];
  };
  for (const entry of entries) {
    if (entry[1].includes("\n")) {
      flush();
      lines.push(`${indentation(depth)}${entry[0]} = ${entry[1]}`);
    } else {
      run.push(entry);
    }
  }
  flush();
  return lines;
}

// An object expression whose closing brace is at `depth`.
function objectExpression(entries: ReadonlyArray<readonly [string, string]>, depth: number): string {
  if (entries.length === 0) return "{}";
  return `{\n${alignedLines(entries, depth + 1).join("\n")}\n${indentation(depth)}}`;
}

// A JSON value as an HCL expression whose closing bracket is at `depth`.
export function hclValue(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return hclString(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.every((item) => item === null || typeof item !== "object")) {
      return `[${value.map((item) => hclValue(item)).join(", ")}]`;
    }
    const items = value.map((item) => `${indentation(depth + 1)}${hclValue(item, depth + 1)},`);
    return `[\n${items.join("\n")}\n${indentation(depth)}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined);
  return objectExpression(entries.map(([key, item]) => [hclKey(key), hclValue(item, depth + 1)] as const), depth);
}

// An attribute value that is already an expression, written as is.
class Expression {
  constructor(readonly text: string) {}
}

// A block with the given attributes, skipping undefined ones.
function block(header: string, attributes: Array<[string, unknown]>): string {
  const present = attributes.flatMap(([key, value]) =>
    value === undefined ? [] : [[key, value instanceof Expression ? value.text : hclValue(value, 1)] as const],
  );
  return `${header} {\n${alignedLines(present, 1).join("\n")}\n}`;
}

// Unique resource names made from display names, such as `checkout_errors`.
class Names {
  private readonly used = new Map<string, Set<string>>();

  take(type: string, display: string): string {
    const used = this.used.get(type) ?? new Set<string>();
    this.used.set(type, used);
    let base = display.toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "").slice(0, 60);
    if (!base) base = type.replace(/^superlog_/u, "");
    if (!/^[a-z_]/u.test(base)) base = `_${base}`;
    let name = base;
    for (let suffix = 2; used.has(name); suffix += 1) name = `${base}_${suffix}`;
    used.add(name);
    return name;
  }
}

// Leaves out unset fields. Empty strings stay, since a filter value or a
// variable's default can be empty on purpose.
function withoutNulls(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined));
}

function nonDefault<T>(value: T, fallback: T): T | undefined {
  return value === fallback ? undefined : value;
}

export function terraformExport(input: TerraformExportInput): string {
  const names = new Names();
  const sections: string[] = [];
  const imports: string[] = [];
  const channels = new Map<string, string>();
  const channelBlocks: string[] = [];
  const variables: string[] = [];

  // A Slack target as a lookup by channel name, or as IDs when the channel
  // is no longer listed.
  function slack(target: Slack): unknown {
    if (!target) return undefined;
    const key = `${target.integrationAccountId}/${target.channelId}`;
    const channel = input.slackChannels.find(
      (item) => item.channelId === target.channelId && item.integrationAccountId === target.integrationAccountId,
    );
    if (!channel) {
      return { channel_id: target.channelId, integration_account_id: target.integrationAccountId };
    }
    let name = channels.get(key);
    if (!name) {
      name = names.take("superlog_slack_channel", channel.name);
      channels.set(key, name);
      const sameName = input.slackChannels.filter((item) => item.name === channel.name).length > 1;
      channelBlocks.push(block(`data "superlog_slack_channel" "${name}"`, [
        ["name", channel.name],
        ["workspace", sameName ? channel.accountName : undefined],
      ]));
    }
    return new Expression(objectExpression([
      ["channel_id", `data.superlog_slack_channel.${name}.channel_id`],
      ["integration_account_id", `data.superlog_slack_channel.${name}.integration_account_id`],
    ], 1));
  }

  function imported(type: string, name: string, id: string) {
    imports.push(`import {\n  to = ${type}.${name}\n  id = ${hclString(id)}\n}`);
  }

  for (const alert of input.alerts) {
    const name = names.take("superlog_alert", alert.name);
    const filter = withoutNulls({
      attributes: alert.filter.resourceAttrs?.length
        ? alert.filter.resourceAttrs.map((item) => withoutNulls({ key: item.key, op: item.op, value: item.value }))
        : undefined,
      metric_kind: alert.filter.metricKind,
      metric_unit: alert.filter.metricUnit,
      min_duration_ms: alert.filter.minDurationMs,
      service: alert.filter.service,
      severity: alert.filter.severity,
      span_name: alert.filter.spanName,
      status_code: alert.filter.statusCode,
    });
    sections.push(block(`resource "superlog_alert" "${name}"`, [
      ["name", alert.name],
      ["enabled", nonDefault(alert.enabled, true)],
      ["source", alert.source],
      ["metric_name", alert.metricName ?? undefined],
      ["aggregation", alert.aggregation],
      ["field", alert.field ?? undefined],
      ["comparator", alert.comparator],
      ["threshold", alert.threshold],
      ["window_minutes", nonDefault(alert.windowMinutes, 5)],
      ["evaluation_interval_seconds", nonDefault(alert.evaluationIntervalSeconds, 60)],
      ["group_mode", nonDefault(alert.groupMode, "single")],
      ["group_by", alert.groupBy ?? undefined],
      ["filter", Object.keys(filter).length > 0 ? filter : undefined],
      ["slack", slack(alert.slack)],
    ]));
    imported("superlog_alert", name, alert.id);
  }

  for (const dashboard of input.dashboards) {
    const name = names.take("superlog_dashboard", dashboard.name);
    const widgets = dashboard.widgets.map((widget) => {
      const { filter, ...rest } = widget.config;
      const config = filter && Object.keys(filter).length > 0 ? { ...rest, filter } : rest;
      const { h, w, x, y } = widget.layout;
      return objectExpression([
        ["title", hclString(widget.title)],
        ["type", hclString(widget.type)],
        ["config", `jsonencode(${hclValue(config, 3)})`],
        ["layout", `{ x = ${x}, y = ${y}, w = ${w}, h = ${h} }`],
      ], 2);
    });
    sections.push(block(`resource "superlog_dashboard" "${name}"`, [
      ["name", dashboard.name],
      [
        "variables",
        dashboard.variables.length > 0
          ? dashboard.variables.map((variable) => withoutNulls({
              name: variable.name,
              label: variable.label,
              attribute_key: variable.attributeKey,
              options: variable.options,
              default_value: variable.defaultValue,
              multi: variable.multi,
            }))
          : undefined,
      ],
      ["widgets", widgets.length > 0 ? new Expression(`[\n${widgets.map((widget) => `    ${widget},`).join("\n")}\n  ]`) : undefined],
    ]));
    imported("superlog_dashboard", name, dashboard.id);
  }

  for (const check of input.checks) {
    const name = names.take("superlog_synthetic_check", check.name);
    const plain = check.headers.filter((header) => !header.secret);
    const secret = check.headers.filter((header) => header.secret);
    const secretValues = secret.map((header) => {
      const variable = names.take("variable", `${name}_${header.name}`);
      variables.push(block(`variable "${variable}"`, [
        ["description", `The ${header.name} header of the ${check.name} check.`],
        ["type", new Expression("string")],
        ["sensitive", true],
      ]));
      return [hclString(header.name), `var.${variable}`] as const;
    });
    sections.push(block(`resource "superlog_synthetic_check" "${name}"`, [
      ["name", check.name],
      ["enabled", nonDefault(check.enabled, true)],
      ["method", nonDefault(check.method, "GET")],
      ["url", check.url],
      ["body", check.body ?? undefined],
      ["headers", plain.length > 0 ? Object.fromEntries(plain.map((header) => [header.name, header.value])) : undefined],
      ["secret_headers", secret.length > 0 ? new Expression(objectExpression(secretValues, 1)) : undefined],
      ["interval_seconds", nonDefault(check.intervalSeconds, 300)],
      ["timeout_ms", nonDefault(check.timeoutMs, 10_000)],
      ["retries", nonDefault(check.retries, 1)],
      ["failures_to_alert", nonDefault(check.failuresToAlert, 1)],
      ["follow_redirects", nonDefault(check.followRedirects, true)],
      [
        "assertions",
        check.assertions.length > 0
          ? check.assertions.map((assertion) => withoutNulls({
              kind: assertion.kind,
              op: assertion.op,
              // The provider reads an empty key as none, and value defaults to "".
              key: assertion.key || undefined,
              value: assertion.value || undefined,
              severity: assertion.severity === "critical" ? undefined : assertion.severity,
            }))
          : undefined,
      ],
      ["slack", slack(check.slack)],
    ]));
    imported("superlog_synthetic_check", name, check.id);
  }

  const header = [
    `terraform {\n  required_providers {\n    superlog = {\n      source = "superloglabs/superlog"\n    }\n  }\n}`,
    `# Set SUPERLOG_API_KEY to an API key from Settings → API keys.\nprovider "superlog" {\n  endpoint = ${hclString(input.endpoint)}\n}`,
  ];
  return `${[...header, ...variables, ...channelBlocks, ...sections, ...imports].join("\n\n")}\n`;
}
