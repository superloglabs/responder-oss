import { Link } from "react-router-dom";
import {
  sidebarUsage,
  type SidebarUsageMeter,
  type SidebarUsageSummary,
} from "../sidebar-usage-state";

// The bar turns amber from this share of the allowance.
const NEAR_LIMIT_PERCENT = 90;

const meterLabels: Record<SidebarUsageMeter["kind"], string> = {
  credit: "Usage credit",
  machine_hours: "Machine hours",
};

function amount(kind: SidebarUsageMeter["kind"], value: number, digits: number): string {
  return kind === "credit" ? `$${value.toFixed(digits)}` : value.toFixed(digits);
}

function amounts(meter: SidebarUsageMeter): string {
  const total = amount(meter.kind, meter.total, Number.isInteger(meter.total) ? 0 : 2);
  const used = amount(meter.kind, meter.used, meter.kind === "credit" ? 2 : 1);
  return meter.kind === "credit" ? `${used} / ${total}` : `${used} / ${total} h`;
}

export function SidebarUsageCard({ summary }: { summary: SidebarUsageSummary | null }) {
  const usage = summary ? sidebarUsage(summary) : null;
  if (!usage) return null;
  return (
    <Link className="sidebarUsage" to="/settings/billing">
      <span className="sidebarUsage__header">
        <span>Usage this period</span>
        <span className="sidebarUsage__plan">{usage.planName}</span>
      </span>
      {usage.meters.map((meter) => (
        <span className="sidebarUsage__meter" key={meter.kind}>
          <span className="sidebarUsage__row">
            <span>{meterLabels[meter.kind]}</span>
            <span className="sidebarUsage__amount">{amounts(meter)}</span>
          </span>
          <span
            aria-label={`${meterLabels[meter.kind]}: ${amounts(meter)} used`}
            aria-valuemax={meter.total}
            aria-valuemin={0}
            aria-valuenow={Math.min(meter.used, meter.total)}
            className={`sidebarUsage__bar${meter.percent >= NEAR_LIMIT_PERCENT ? " sidebarUsage__bar--near" : ""}`}
            role="progressbar"
          >
            <span style={{ width: `${meter.percent}%` }} />
          </span>
        </span>
      ))}
    </Link>
  );
}
