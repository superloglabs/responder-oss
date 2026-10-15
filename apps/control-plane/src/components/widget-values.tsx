import { formatWidgetValue, valueChange, widgetFieldLabel, type WidgetUnit, type WidgetValueRow } from "../dashboards-api";

// One value for the window, with how it moved since the window before.
export function NumberValue({
  previous,
  unit,
  value,
}: {
  previous?: number | null;
  unit: WidgetUnit;
  value: number | null;
}) {
  const change = previous === undefined ? null : valueChange(value, previous, unit);
  return (
    <div className="widgetNumber">
      <p className="widgetNumber__value">{formatWidgetValue(value, unit)}</p>
      {change ? <p className="widgetNumber__change">{change}</p> : null}
    </div>
  );
}

// One bar per group, longest first, with its value beside it.
export function BarListValues({ rows, unit }: { rows: WidgetValueRow[]; unit: WidgetUnit }) {
  const largest = Math.max(0, ...rows.map((row) => Math.abs(row.value ?? 0)));
  return (
    <ul className="widgetBars">
      {rows.map((row) => {
        const name = row.group || "(none)";
        const value = formatWidgetValue(row.value, unit);
        const change = row.previous === undefined ? null : valueChange(row.value, row.previous, unit);
        const width = largest > 0 ? (Math.abs(row.value ?? 0) / largest) * 100 : 0;
        return (
          <li className="widgetBars__row" key={name} title={`${name}: ${value}${change ? ` (${change})` : ""}`}>
            <span className={row.group ? "widgetBars__name" : "widgetBars__name dashboardWidget__muted"}>{name}</span>
            <span aria-hidden="true" className="widgetBars__track">
              <span className="widgetBars__bar" style={{ width: `${width}%` }} />
            </span>
            <span className="widgetBars__value">{value}</span>
          </li>
        );
      })}
    </ul>
  );
}

// One row per group, with the window before and the change when compared.
export function ValueTable({
  groupBy,
  rows,
  unit,
  valueLabel,
}: {
  groupBy: string;
  rows: WidgetValueRow[];
  unit: WidgetUnit;
  valueLabel: string;
}) {
  const compared = rows.some((row) => row.previous !== undefined);
  return (
    <table className="dashboardWidget__table widgetValueTable">
      <thead>
        <tr>
          <th scope="col">{widgetFieldLabel(groupBy)}</th>
          <th className="dashboardWidget__number" scope="col">{valueLabel}</th>
          {compared ? <th className="dashboardWidget__number" scope="col">Previous</th> : null}
          {compared ? <th className="dashboardWidget__number" scope="col">Change</th> : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.group || "(none)"}>
            <td className={row.group ? undefined : "dashboardWidget__muted"} title={row.group}>{row.group || "(none)"}</td>
            <td className="dashboardWidget__number">{formatWidgetValue(row.value, unit)}</td>
            {compared ? (
              <td className="dashboardWidget__number dashboardWidget__muted">{formatWidgetValue(row.previous ?? null, unit)}</td>
            ) : null}
            {compared ? (
              <td className="dashboardWidget__number dashboardWidget__muted">
                {valueChange(row.value, row.previous ?? null, unit, { short: true })}
              </td>
            ) : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
