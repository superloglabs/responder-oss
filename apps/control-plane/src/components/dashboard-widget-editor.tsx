import { useEffect, useState } from "react";
import { Button, SegmentedControl, SelectField, Switch, TextAreaField, TextField } from "../design-system";
import { resolveTimeRange, type DashboardTimeRange } from "../dashboard-time-range";
import {
  emptyWidgetForm,
  widgetDraft,
  widgetForm,
  type WidgetForm,
  type WidgetKind,
  type WidgetSource,
} from "../dashboard-widget-draft";
import {
  aiGroupFields,
  aiMeasureFields,
  fetchAttributeKeys,
  fetchMetricNames,
  widgetAggregationLabels,
  widgetChartType,
  type DashboardVariable,
  type MetricName,
  type VariableValues,
  type WidgetDisplay,
  type WidgetDraft,
} from "../dashboards-api";
import { widgetFieldSource } from "../../../../packages/core/src/telemetry/dashboards";
import { DashboardDialog } from "./dashboard-dialog";
import { AttributeFilters } from "./attribute-filters";
import { DashboardWidgetBody } from "./dashboard-widget";
import { metricPickerChoice, metricPickerOptions, metricPickerValue, pickedMetricLabel } from "../metric-picker";

const kinds: Array<{ label: string; value: WidgetKind }> = [
  { label: "Chart", value: "chart" },
  { label: "List", value: "table" },
  { label: "Note", value: "note" },
];

const displays: Array<{ label: string; value: WidgetDisplay }> = [
  { label: "Over time", value: "timeseries" },
  { label: "Number", value: "number" },
  { label: "Bars", value: "bar_list" },
  { label: "Table", value: "table" },
];

// Logs and spans are counted, or summed up from a field.
const eventAggregations = (["count", "count_distinct", "sum", "avg", "min", "max", "p50", "p90", "p95", "p99"] as const).map(
  (value) => ({ label: widgetAggregationLabels[value], value: value === "count" ? ("" as const) : value }),
);

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
  { label: "US dollars", value: "usd" },
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
  timeZone,
  variables,
  variableValues,
}: {
  initial: WidgetDraft | null;
  onClose: () => void;
  onSave: (draft: WidgetDraft) => Promise<void>;
  projectId: string;
  range: DashboardTimeRange;
  timeZone: string;
  variables: DashboardVariable[];
  variableValues: VariableValues;
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
  // Metrics and attributes seen in the dashboard's range when the editor opened.
  const [seenIn] = useState(() => resolveTimeRange(range, Date.now()));

  useEffect(() => {
    if (form.kind !== "chart" || form.source !== "metric") return;
    let cancelled = false;
    fetchMetricNames(projectId, seenIn)
      .then((loaded) => { if (!cancelled) setMetrics(loaded); })
      .catch(() => { if (!cancelled) setMetrics([]); });
    return () => { cancelled = true; };
  }, [form.kind, form.source, projectId, seenIn]);

  useEffect(() => {
    if (form.kind === "note") return;
    let cancelled = false;
    fetchAttributeKeys(projectId, seenIn, attributeSource)
      .then((loaded) => { if (!cancelled) setKeys(loaded); })
      .catch(() => { if (!cancelled) setKeys([]); });
    return () => { cancelled = true; };
  }, [attributeSource, form.kind, projectId, seenIn]);

  // An aggregation other than a count needs a field to read.
  const needsField = form.kind === "chart" && form.source !== "metric" && form.aggregation !== "" && form.aggregation !== "count" && !form.field;

  async function save() {
    if (draft.type === "timeseries_metric" && !draft.config.metricName) {
      setError("Choose a metric.");
      return;
    }
    if (needsField) {
      setError("Choose a field to aggregate.");
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
  const aiGroups: Array<{ label: string; value: string }> = form.source === "traces" && form.kind === "chart" ? [...aiGroupFields] : [];
  const groupOptions = [
    { label: "No grouping", value: "" },
    { label: "Service", value: "service" },
    ...aiGroups,
    ...withCurrent(keys, form.groupBy === "service" || aiGroups.some((group) => group.value === form.groupBy) ? "" : form.groupBy)
      .map((key) => ({ label: key, value: key })),
  ];
  const previewReady = (preview.type !== "timeseries_metric" || Boolean(preview.config.metricName)) && !needsField;
  const overTime = form.display === "timeseries";
  // Spans offer their duration and AI usage before their attributes.
  const builtInFields: Array<{ description?: string; label: string; value: string }> = form.source === "traces"
    ? [{ label: "Duration", value: "duration" }, ...aiMeasureFields.map((field) => ({ ...field, description: "AI usage" }))]
    : [];
  const fieldOptions = [
    ...(form.field ? [] : [{ label: "Choose a field", value: "" }]),
    ...builtInFields,
    ...withCurrent(keys, builtInFields.some((field) => field.value === form.field) ? "" : form.field).map((key) => ({ label: key, value: key })),
  ];
  const picked = { kind: form.metricKind, name: form.metricName, unit: form.metricUnit };
  const metricValue = form.metricName ? metricPickerValue(picked) : "";
  const metricOptions = metricPickerOptions(metrics);
  if (metricValue && !metricOptions.some((option) => option.value === metricValue)) {
    metricOptions.unshift({ label: pickedMetricLabel(picked), value: metricValue });
  }

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
            <SegmentedControl
              aria-label="Data"
              onChange={(value) => {
                // A field only one signal has is cleared when switching to the other.
                const fieldSource = widgetFieldSource(form.field);
                update(fieldSource && fieldSource !== value ? { field: "", source: value } : { source: value });
              }}
              options={sources}
              value={source}
            />
          ) : null}
          {form.kind === "chart" && form.source === "metric" ? (
            <>
              <SelectField
                label="Metric"
                onChange={(value) => {
                  const { kind, name, unit } = value ? metricPickerChoice(value) : { kind: "" as const, name: "", unit: null };
                  update({ metricKind: kind, metricName: name, metricUnit: unit });
                }}
                options={[
                  ...(form.metricName ? [] : [{ label: "Choose a metric", value: "" }]),
                  ...metricOptions,
                ]}
                searchable
                value={metricValue}
              />
              <SelectField
                label="Aggregation"
                onChange={(aggregation) => update({ aggregation })}
                options={[...aggregations]}
                value={form.aggregation}
              />
            </>
          ) : null}
          {form.kind === "chart" && form.source !== "metric" ? (
            <div className="widgetEditor__row">
              <SelectField
                label="Measure"
                onChange={(aggregation) => update({ aggregation })}
                options={eventAggregations}
                value={form.aggregation === "count" ? "" : form.aggregation}
              />
              {form.aggregation && form.aggregation !== "count" ? (
                <SelectField
                  label="Field"
                  onChange={(field) => {
                    // Suggest the unit a built-in field is in. A distinct
                    // count is a count, whatever the field.
                    const unit = form.aggregation === "count_distinct"
                      ? null
                      : field === "duration" ? "duration_ms" : field === "ai:cost" ? "usd" : null;
                    update(unit && form.unit === "none" ? { field, unit } : { field });
                  }}
                  options={fieldOptions}
                  searchable={fieldOptions.length > 8}
                  value={form.field}
                />
              ) : null}
            </div>
          ) : null}
          {form.kind === "chart" ? (
            <SegmentedControl aria-label="Display" onChange={(display) => update({ display })} options={displays} value={form.display} />
          ) : null}
          {form.kind === "chart" && form.display !== "number" ? (
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
                  label={overTime ? "Series" : "Rows"}
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
            <AttributeFilters
              actions={variables.map((variable) => (
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
              filters={form.filters}
              keys={keys}
              onChange={(filters) => update({ filters })}
            />
          ) : null}
          {form.kind === "chart" ? (
            <div className="widgetEditor__row">
              {overTime && widgetChartType(draft.type, { ...draft.config, chartType: "bar" }) === "bar" ? (
                <SegmentedControl
                  aria-label="Chart type"
                  onChange={(chartType) => update({ chartType })}
                  options={[{ label: "Bars", value: "bar" }, { label: "Lines", value: "line" }]}
                  value={form.chartType}
                />
              ) : null}
              <SelectField label="Unit" onChange={(unit) => update({ unit })} options={[...units]} value={form.unit} />
            </div>
          ) : null}
          {form.kind === "chart" && !overTime ? (
            <Switch
              checked={form.compare}
              label="Compare with the previous period"
              onCheckedChange={(compare) => update({ compare })}
            />
          ) : null}
          {form.kind === "chart" && overTime ? (
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
                timeZone={timeZone}
                title={preview.title}
                type={preview.type}
                variables={variableValues}
              />
            ) : (
              <p className="dashboardWidget__status">
                {needsField ? "Choose a field to preview it." : "Choose a metric to preview it."}
              </p>
            )}
          </div>
        </section>
      </div>
    </DashboardDialog>
  );
}
