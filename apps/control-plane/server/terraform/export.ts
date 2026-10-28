import { organizationHasCapability } from "../../../../packages/core/src/db/organization-capabilities.js";
import { listSyntheticChecks } from "../../../../packages/core/src/db/synthetic-checks.js";
import { listTelemetryAlerts, listTelemetryAlertSlackChannels } from "../../../../packages/core/src/db/telemetry-alerts.js";
import {
  findTelemetryDashboard,
  listTelemetryDashboards,
  type TelemetryDashboard,
} from "../../../../packages/core/src/db/telemetry-dashboards.js";
import { getTelemetryClient } from "../../../../packages/core/src/telemetry/client.js";
import { terraformExport } from "../../../../packages/core/src/terraform/export.js";
import { controlPlaneBaseUrl } from "../integrations/urls.js";

// Which objects to export. Without any IDs, everything is exported.
export type TerraformSelection = {
  alertIds?: readonly string[];
  dashboardIds?: readonly string[];
  syntheticCheckIds?: readonly string[];
};

export type TerraformExportResult =
  | { hcl: string; ok: true; resources: number }
  | { error: string; ok: false };

function selected<Item extends { id: string }>(items: readonly Item[], ids: readonly string[] | undefined): Item[] {
  return ids ? items.filter((item) => ids.includes(item.id)) : [...items];
}

// The workspace's alerts, dashboards, and synthetic checks as Terraform
// configuration. Kinds the workspace cannot use are left out, and asking
// for one by ID is an error.
export async function buildTerraformExport(
  organizationId: string,
  requested: TerraformSelection,
): Promise<TerraformExportResult> {
  const everything = !requested.alertIds?.length && !requested.dashboardIds?.length && !requested.syntheticCheckIds?.length;
  const selection: TerraformSelection = everything
    ? {}
    : {
        alertIds: requested.alertIds ?? [],
        dashboardIds: requested.dashboardIds ?? [],
        syntheticCheckIds: requested.syntheticCheckIds ?? [],
      };
  const [telemetry, alertsOn, dashboardsOn] = await Promise.all([
    organizationHasCapability(organizationId, "telemetry"),
    organizationHasCapability(organizationId, "alerts"),
    organizationHasCapability(organizationId, "dashboards"),
  ]);
  const store = Boolean(getTelemetryClient());
  const canAlert = telemetry && alertsOn && store;
  const canDashboard = telemetry && dashboardsOn && store;
  if (selection.alertIds?.length && !canAlert) return { error: "Alerts are not available in this workspace.", ok: false };
  if (selection.dashboardIds?.length && !canDashboard) {
    return { error: "Dashboards are not available in this workspace.", ok: false };
  }
  if (selection.syntheticCheckIds?.length && !alertsOn) {
    return { error: "Synthetic checks are not available in this workspace.", ok: false };
  }

  const [alerts, checks, summaries, slackChannels] = await Promise.all([
    canAlert && selection.alertIds?.length !== 0 ? listTelemetryAlerts(organizationId) : [],
    alertsOn && selection.syntheticCheckIds?.length !== 0 ? listSyntheticChecks(organizationId) : [],
    canDashboard && selection.dashboardIds?.length !== 0 ? listTelemetryDashboards(organizationId) : [],
    alertsOn ? listTelemetryAlertSlackChannels(organizationId) : [],
  ]);
  const dashboards = (
    await Promise.all(
      selected(summaries, selection.dashboardIds).map((summary) => findTelemetryDashboard(organizationId, summary.id)),
    )
  ).filter((dashboard): dashboard is TelemetryDashboard => dashboard !== null);
  const input = {
    alerts: selected(alerts, selection.alertIds),
    checks: selected(checks, selection.syntheticCheckIds),
    dashboards: dashboards.sort((a, b) => a.name.localeCompare(b.name)),
  };
  const missing = [
    ...(selection.alertIds ?? []).filter((id) => !input.alerts.some((alert) => alert.id === id)),
    ...(selection.dashboardIds ?? []).filter((id) => !input.dashboards.some((dashboard) => dashboard.id === id)),
    ...(selection.syntheticCheckIds ?? []).filter((id) => !input.checks.some((check) => check.id === id)),
  ];
  if (missing.length > 0) return { error: `Not found: ${missing.join(", ")}`, ok: false };
  return {
    hcl: terraformExport({ ...input, endpoint: new URL(controlPlaneBaseUrl()).origin, slackChannels }),
    ok: true,
    resources: input.alerts.length + input.checks.length + input.dashboards.length,
  };
}
