import { PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { Button, IconButton, SegmentedControl, SelectField, Switch, TextAreaField, TextField } from "../design-system";
import {
  emptyWidgetForm,
  widgetDraft,
  widgetForm,
  type WidgetForm,
  type WidgetKind,
  type WidgetSource,
} from "../dashboard-widget-draft";
import {
  fetchAttributeKeys,
  fetchMetricNames,
  type DashboardVariable,
  type MetricName,
  type WidgetDraft,
} from "../dashboards-api";
import type { TelemetryRange } from "../telemetry-api";
import { DashboardDialog } from "./dashboard-dialog";
import { DashboardWidgetBody } from "./dashboard-widget";

const kinds: Array<{ label: string; value: WidgetKind }> = [
  { label: "Chart", value: "chart" },
  { label: "Table", value: "table" },
  { label: "Note", value: "note" },
];

const aggregations = [
  { label: "Default for the metric", value: "" },
  { label: "Sum", value: "sum" },
  { label: "Average", value: "avg" },
  { label: "Minimum", value: "min" },
  { label: "Maximum", value: "max" },
  { label: "95th percentile", value: "p95" },
  { label: "99th percentile", value: "p99" },
] as const;

const units = [
  { label: "Number", value: "none" },
  { label: "Milliseconds", value: "duration_ms" },
  { label: "Seconds", value: "duration_s" },
  { label: "Bytes", value: "bytes" },
  { label: "Percent", value: "percent" },
] as const;

const operators = [
  { label: "is", value: "eq" },
  { label: "is not", value: "neq" },
  { label: "does not contain", value: "not_contains" },
] as const;

function withCurrent(options: string[], current: string): string[] {
  return current && !options.includes(current) ? [current, ...options] : options;
}

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

// Builds a new widget or edits one, with a preview of its data.
export function DashboardWidgetEditor({
  initial,
  onClose,
  onSave,
  projectId,
  range,
  variables,
  variableValues,
}: {
  initial: WidgetDraft | null;
  onClose: () => void;
  onSave: (draft: WidgetDraft) => Promise<void>;
  projectId: string;
  range: TelemetryRange;
  variables: DashboardVariable[];
  variableValues: Record<string, string>;
}) {
  const [form, setForm] = useState<WidgetForm>(() => (initial ? widgetForm(initial) : emptyWidgetForm));
  const [metrics, setMetrics] = useState<MetricName[]>([]);
  const [keys, setKeys] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draft = widgetDraft(form);
  const preview = useDebounced(draft, 400);
  const attributeSource = form.source === "metric" && form.kind === "chart" ? "metrics" : form.source === "traces" ? "traces" : "logs";
  const update = (change: Partial<WidgetForm>) => setForm((current) => ({ ...current, ...change }));

  useEffect(() => {
    if (form.kind !== "chart" || form.source !== "metric") return;
    let cancelled = false;
    fetchMetricNames(projectId, "24h")
      .then((loaded) => { if (!cancelled) setMetrics(loaded); })
      .catch(() => { if (!cancelled) setMetrics([]); });
    return () => { cancelled = true; };
  }, [form.kind, form.source, projectId]);

  useEffect(() => {
    if (form.kind === "note") return;
    let cancelled = false;
    fetchAttributeKeys(projectId, "24h", attributeSource)
      .then((loaded) => { if (!cancelled) setKeys(loaded); })
      .catch(() => { if (!cancelled) setKeys([]); });
    return () => { cancelled = true; };
  }, [attributeSource, form.kind, projectId]);

  async function save() {
    if (draft.type === "timeseries_metric" && !draft.config.metricName) {
      setError("Choose a metric.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save the widget");
      setSaving(false);
    }
  }

  const sources: Array<{ label: string; value: WidgetSource }> =
    form.kind === "chart"
      ? [{ label: "Logs", value: "logs" }, { label: "Spans", value: "traces" }, { label: "Metric", value: "metric" }]
      : [{ label: "Logs", value: "logs" }, { label: "Traces", value: "traces" }];
  const source = form.kind === "table" && form.source === "metric" ? "logs" : form.source;
  const groupOptions = [
    { label: "No grouping", value: "" },
    { label: "Service", value: "service" },
    ...withCurrent(keys, form.groupBy === "service" ? "" : form.groupBy).map((key) => ({ label: key, value: key })),
  ];
  const previewReady = preview.type !== "timeseries_metric" || Boolean(preview.config.metricName);

  return (
    <DashboardDialog
      actions={
        <>
          <Button onClick={onClose} variant="ghost">Cancel</Button>
          <Button loading={saving} onClick={() => void save()} variant="primary">
            {initial ? "Save widget" : "Add widget"}
          </Button>
        </>
      }
      onClose={onClose}
      title={initial ? "Edit widget" : "Add widget"}
      wide
    >
      <div className="widgetEditor">
        <div className="widgetEditor__form">
          <SegmentedControl aria-label="Widget kind" onChange={(kind) => update({ kind })} options={kinds} value={form.kind} />
          {form.kind !== "note" ? (
            <SegmentedControl aria-label="Data" onChange={(value) => update({ source: value })} options={sources} value={source} />
          ) : null}
          {form.kind === "chart" && form.source === "metric" ? (
            <>
              <SelectField
                label="Metric"
                onChange={(metricName) => update({ metricName })}
                options={[
                  ...(form.metricName ? [] : [{ label: "Choose a metric", value: "" }]),
                  ...withCurrent(metrics.map((metric) => metric.name), form.metricName).map((name) => {
                    const metric = metrics.find((candidate) => candidate.name === name);
                    return { label: metric?.unit ? `${name} (${metric.unit})` : name, value: name };
                  }),
                ]}
                searchable
                value={form.metricName}
              />
              <SelectField
                label="Aggregation"
                onChange={(aggregation) => update({ aggregation })}
                options={[...aggregations]}
                value={form.aggregation}
              />
            </>
          ) : null}
          {form.kind === "chart" ? (
            <div className="widgetEditor__row">
              <SelectField
                label="Group by"
                onChange={(groupBy) => update({ groupBy })}
                options={groupOptions}
                searchable={groupOptions.length > 8}
                value={form.groupBy}
              />
              {form.groupBy ? (
                <TextField
                  className="widgetEditor__number"
                  label="Series"
                  max={50}
                  min={1}
                  onChange={(event) => update({ limit: Math.max(1, Math.min(50, Number(event.target.value) || 1)) })}
                  type="number"
                  value={form.limit}
                />
              ) : null}
            </div>
          ) : null}
          {form.kind === "table" ? (
            <TextField
              className="widgetEditor__number"
              label="Rows"
              max={source === "traces" ? 200 : 500}
              min={1}
              onChange={(event) => update({ rows: Math.max(1, Number(event.target.value) || 1) })}
              type="number"
              value={form.rows}
            />
          ) : null}
          {form.kind !== "note" ? (
            <fieldset className="widgetEditor__filters">
              <legend>Filters</legend>
              {form.filters.map((filter, index) => (
                <div className="widgetEditor__filter" key={index}>
                  <SelectField
                    label="Attribute"
                    onChange={(key) => update({ filters: form.filters.map((item, at) => (at === index ? { ...item, key } : item)) })}
                    options={[
                      ...(filter.key ? [] : [{ label: "Attribute", value: "" }]),
                      ...withCurrent(keys, filter.key).map((key) => ({ label: key, value: key })),
                    ]}
                    searchable
                    value={filter.key}
                  />
                  <SelectField
                    label="Comparison"
                    onChange={(op) =>
                      update({
                        filters: form.filters.map((item, at) => (at === index ? { ...item, ...(op === "eq" ? { op: undefined } : { op }) } : item)),
                      })
                    }
                    options={[...operators]}
                    value={filter.op ?? "eq"}
                  />
                  <TextField
                    label="Value"
                    maxLength={500}
                    onChange={(event) =>
                      update({ filters: form.filters.map((item, at) => (at === index ? { ...item, value: event.target.value } : item)) })
                    }
                    value={filter.value}
                  />
                  <IconButton
                    aria-label="Remove filter"
                    onClick={() => update({ filters: form.filters.filter((_, at) => at !== index) })}
                    size="small"
                    variant="ghost"
                  >
                    <TrashIcon size={14} />
                  </IconButton>
                </div>
              ))}
              <div className="widgetEditor__filterActions">
                <Button onClick={() => update({ filters: [...form.filters, { key: "", value: "" }] })} size="small" variant="secondary">
                  <PlusIcon size={12} />Add filter
                </Button>
                {variables.map((variable) => (
                  <Button
                    key={variable.name}
                    onClick={() =>
                      update({ filters: [...form.filters, { key: variable.attributeKey || variable.name, value: `$${variable.name}` }] })
                    }
                    size="small"
                    variant="ghost"
                  >
                    Filter by ${variable.name}
                  </Button>
                ))}
              </div>
            </fieldset>
          ) : null}
          {form.kind === "chart" ? (
            <div className="widgetEditor__row">
              <SegmentedControl
                aria-label="Chart type"
                onChange={(chartType) => update({ chartType })}
                options={[{ label: "Bars", value: "bar" }, { label: "Lines", value: "line" }]}
                value={form.chartType}
              />
              <SelectField label="Unit" onChange={(unit) => update({ unit })} options={[...units]} value={form.unit} />
            </div>
          ) : null}
          {form.kind === "chart" ? (
            <div className="widgetEditor__row">
              <Switch checked={form.showLegend} label="Legend" onCheckedChange={(showLegend) => update({ showLegend })} />
              {form.showLegend ? (
                <SegmentedControl
                  aria-label="Legend position"
                  onChange={(legendPosition) => update({ legendPosition })}
                  options={[{ label: "Below", value: "bottom" }, { label: "Beside", value: "side" }]}
                  value={form.legendPosition}
                />
              ) : null}
            </div>
          ) : null}
          {form.kind === "note" ? (
            <TextAreaField
              hint="Markdown: headings, lists, links, bold and code."
              label="Note"
              maxLength={20_000}
              onChange={(event) => update({ markdown: event.target.value })}
              rows={10}
              value={form.markdown}
            />
          ) : null}
          <TextField
            label="Title"
            maxLength={200}
            onChange={(event) => update({ title: event.target.value })}
            placeholder={widgetDraft({ ...form, title: "" }).title}
            value={form.title}
          />
          {error ? <p className="formError" role="alert">{error}</p> : null}
        </div>
        <section aria-label="Preview" className="widgetEditor__preview">
          <h3>{draft.title}</h3>
          <div className="widgetEditor__previewBody">
            {previewReady ? (
              <DashboardWidgetBody
                config={preview.config}
                projectId={projectId}
                range={range}
                refresh={0}
                title={preview.title}
                type={preview.type}
                variables={variableValues}
              />
            ) : (
              <p className="dashboardWidget__status">Choose a metric to preview it.</p>
            )}
          </div>
        </section>
      </div>
    </DashboardDialog>
  );
}
