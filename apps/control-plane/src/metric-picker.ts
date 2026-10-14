import type { MetricName } from "./dashboards-api";
import { metricKindLabel, type MetricKind } from "./metrics-api";

// One metric in a picker: its kind, name and unit. A widget or alert that
// names only a metric keeps an empty kind and a null unit, and reads every
// kind and unit of the name.
export interface PickedMetric {
  kind: MetricKind | "";
  name: string;
  unit: string | null;
}

export function metricPickerValue(metric: PickedMetric): string {
  return JSON.stringify([metric.kind, metric.name, metric.unit]);
}

export function metricPickerChoice(value: string): PickedMetric {
  const [kind, name, unit] = JSON.parse(value) as [PickedMetric["kind"], string, string | null];
  return { kind, name, unit };
}

// Each kind and unit of a name is its own option. Units tell most apart;
// the kind is named when a name and unit are sent as more than one kind.
export function metricPickerOptions(metrics: MetricName[]): Array<{ label: string; value: string }> {
  const kindsOf = new Map<string, number>();
  for (const metric of metrics) {
    const key = JSON.stringify([metric.name, metric.unit]);
    kindsOf.set(key, (kindsOf.get(key) ?? 0) + 1);
  }
  return metrics.map((metric) => {
    const kind = metric.kind as MetricKind;
    const unit = metric.unit ? ` (${metric.unit})` : "";
    const shared = (kindsOf.get(JSON.stringify([metric.name, metric.unit])) ?? 0) > 1;
    return {
      label: `${metric.name}${unit}${shared ? ` · ${metricKindLabel(kind)}` : ""}`,
      value: metricPickerValue({ kind, name: metric.name, unit: metric.unit }),
    };
  });
}

// The label of a picked metric that is not among the options.
export function pickedMetricLabel(metric: PickedMetric): string {
  return metric.unit ? `${metric.name} (${metric.unit})` : metric.name;
}
