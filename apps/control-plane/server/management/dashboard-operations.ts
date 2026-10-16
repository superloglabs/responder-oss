import { z } from "zod";
import { organizationHasCapability } from "../../../../packages/core/src/db/organization-capabilities.js";
import {
  addTelemetryDashboardWidget,
  createTelemetryDashboard,
  deleteTelemetryDashboard,
  deleteTelemetryDashboardWidget,
  findTelemetryDashboard,
  listTelemetryDashboards,
  updateTelemetryDashboard,
  updateTelemetryDashboardLayout,
  updateTelemetryDashboardWidget,
  type TelemetryDashboard,
} from "../../../../packages/core/src/db/telemetry-dashboards.js";
import { getTelemetryClient } from "../../../../packages/core/src/telemetry/client.js";
import {
  dashboardVariablesSchema,
  dashboardWidgetConfigSchema,
  dashboardWidgetLayoutSchema,
  dashboardWidgetTypes,
  defaultWidgetLayout,
  widgetConfigProblem,
  type DashboardWidgetConfig,
  type DashboardWidgetType,
} from "../../../../packages/core/src/telemetry/dashboards.js";
import { controlPlaneBaseUrl } from "../integrations/urls.js";
import {
  defineOperation,
  ManagementError,
  type ManagementContext,
} from "./operation.js";

// Dashboards over the workspace's telemetry, as the Dashboards page shows
// them. They need the telemetry and dashboards features and a telemetry store.

const dashboardId = z.uuid().describe("Dashboard ID.");
const widgetId = z.uuid().describe("Widget ID.");
const dashboardName = z.string().trim().min(1).max(120);
const widgetTitle = z.string().trim().min(1).max(200);

const variables = dashboardVariablesSchema.describe(
  "Dropdowns shown on the dashboard. A widget filter uses the selected value when its value is `$name` or `${name}`, such as `{ key: \"deployment.environment\", value: \"$env\" }`. `options` lists the choices; leave it empty to type a value. `defaultValue` must be one of `options` when there are any. `multi` allows several values. `attributeKey` is the attribute the variable usually filters.",
);
const widgetType = z
  .enum(dashboardWidgetTypes)
  .describe(
    "`timeseries_count` counts or aggregates logs or spans, `timeseries_metric` charts one metric, `log_table` and `trace_table` list matching logs or traces, and `markdown` shows text.",
  );
const widgetConfig = dashboardWidgetConfigSchema.describe(
  "What the widget reads and how it shows it. `source` is `logs` or `traces`. `filter.resourceAttrs` keys may start with `resource.`, `span.`, `log.`, or `field.`; a bare key is a resource attribute. `aggregation` defaults to `count`; other aggregations read `field`, which is `duration` or an attribute key. `groupBy` splits the result into series by an attribute key. `display` is `timeseries`, `number`, `bar_list`, or `table`. Metric widgets need `metricName`.",
);
const widgetLayout = dashboardWidgetLayoutSchema.describe(
  "Position on a 12-column grid: `x` 0 to 11, `w` 1 to 12, and `y` and `h` in rows. Charts are usually 6 wide and 4 high, tables 12 by 6, and text 4 by 5.",
);

const widgetSchema = z.object({
  config: z.record(z.string(), z.unknown()).describe("The widget's settings."),
  id: widgetId,
  layout: z.object({ h: z.number(), w: z.number(), x: z.number(), y: z.number() }),
  position: z.number().int(),
  title: z.string(),
  type: z.enum(dashboardWidgetTypes),
});
const dashboardSchema = z.object({
  id: dashboardId,
  name: z.string(),
  updatedAt: z.iso.datetime({ offset: true }),
  url: z.url().describe("The dashboard in Superlog."),
  variables: z.array(z.record(z.string(), z.unknown())),
  widgets: z.array(widgetSchema),
});

function dashboardUrl(id: string): string {
  return new URL(`/dashboards/${id}`, controlPlaneBaseUrl()).href;
}

function withUrl(dashboard: TelemetryDashboard) {
  return { ...dashboard, url: dashboardUrl(dashboard.id) };
}

const dashboardNotFound = () => new ManagementError(404, "Dashboard not found", "dashboard_not_found");
const widgetNotFound = () => new ManagementError(404, "Widget not found", "widget_not_found");

async function requireDashboards(context: ManagementContext): Promise<void> {
  const [telemetry, dashboards] = await Promise.all([
    organizationHasCapability(context.organizationId, "telemetry"),
    organizationHasCapability(context.organizationId, "dashboards"),
  ]);
  if (!getTelemetryClient() || !telemetry || !dashboards) {
    throw new ManagementError(404, "Dashboards are not available in this workspace.", "dashboards_unavailable");
  }
}

async function requireDashboard(context: ManagementContext, id: string): Promise<TelemetryDashboard> {
  const dashboard = await findTelemetryDashboard(context.organizationId, id);
  if (!dashboard) throw dashboardNotFound();
  return dashboard;
}

// A chart's settings must be queryable for its type, as the editor checks.
function checkWidgetConfig(type: DashboardWidgetType, config: DashboardWidgetConfig): void {
  const problem = widgetConfigProblem(type, config);
  if (problem) {
    throw new ManagementError(400, "Invalid widget", "invalid_request", [{
      code: "custom",
      input: config,
      message: problem.message,
      path: ["config", problem.field],
    }]);
  }
}

export const dashboardOperations = [
  defineOperation({
    name: "list_dashboards",
    summary: "List dashboards",
    description: "Lists the workspace's dashboards, most recently changed first, with how many widgets each has.",
    method: "GET",
    path: "/dashboards",
    tag: "Dashboards",
    effect: "read",
    input: z.object({}),
    output: z.object({
      dashboards: z.array(z.object({
        id: dashboardId,
        name: z.string(),
        updatedAt: z.iso.datetime({ offset: true }),
        url: z.url(),
        widgetCount: z.number().int(),
      })),
    }),
    async run(context) {
      await requireDashboards(context);
      const dashboards = await listTelemetryDashboards(context.organizationId);
      return { dashboards: dashboards.map((dashboard) => ({ ...dashboard, url: dashboardUrl(dashboard.id) })) };
    },
  }),
  defineOperation({
    name: "get_dashboard",
    summary: "Get a dashboard",
    description: "Returns a dashboard with its variables and every widget's type, settings, and position.",
    method: "GET",
    path: "/dashboards/{dashboardId}",
    tag: "Dashboards",
    effect: "read",
    input: z.object({ dashboardId }),
    output: z.object({ dashboard: dashboardSchema }),
    async run(context, input) {
      await requireDashboards(context);
      return { dashboard: withUrl(await requireDashboard(context, input.dashboardId)) };
    },
  }),
  defineOperation({
    name: "create_dashboard",
    summary: "Create a dashboard",
    description: "Creates an empty dashboard, optionally with variables. Widgets are added to it afterward.",
    method: "POST",
    path: "/dashboards",
    tag: "Dashboards",
    effect: "write",
    successStatus: 201,
    input: z.object({ name: dashboardName, variables: variables.optional() }),
    output: z.object({ dashboard: dashboardSchema }),
    async run(context, input) {
      await requireDashboards(context);
      const dashboard = await createTelemetryDashboard(context.organizationId, {
        createdBy: context.user.id,
        name: input.name,
        ...(input.variables ? { variables: input.variables } : {}),
      });
      return { dashboard: withUrl(dashboard) };
    },
  }),
  defineOperation({
    name: "update_dashboard",
    summary: "Rename a dashboard or change its variables",
    description:
      "Changes a dashboard's name, its variables, or both. `variables` replaces the whole list, so include every variable to keep.",
    method: "PATCH",
    path: "/dashboards/{dashboardId}",
    tag: "Dashboards",
    effect: "destructive",
    input: z.object({ dashboardId, name: dashboardName.optional(), variables: variables.optional() }),
    output: z.object({ dashboard: dashboardSchema }),
    async run(context, input) {
      await requireDashboards(context);
      if (input.name === undefined && input.variables === undefined) {
        throw new ManagementError(400, "Send a name or variables to change.", "nothing_to_update");
      }
      const dashboard = await updateTelemetryDashboard(context.organizationId, input.dashboardId, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.variables !== undefined ? { variables: input.variables } : {}),
      });
      if (!dashboard) throw dashboardNotFound();
      return { dashboard: withUrl(dashboard) };
    },
  }),
  defineOperation({
    name: "delete_dashboard",
    summary: "Delete a dashboard",
    description: "Deletes a dashboard and all of its widgets.",
    method: "DELETE",
    path: "/dashboards/{dashboardId}",
    tag: "Dashboards",
    effect: "destructive",
    input: z.object({ dashboardId }),
    output: z.object({ deleted: z.literal(true) }),
    async run(context, input) {
      await requireDashboards(context);
      if (!(await deleteTelemetryDashboard(context.organizationId, input.dashboardId))) throw dashboardNotFound();
      return { deleted: true as const };
    },
  }),
  defineOperation({
    name: "add_dashboard_widget",
    summary: "Add a widget to a dashboard",
    description:
      "Adds a chart, table, or text widget to a dashboard. Without a layout, the widget gets the standard size for its type below the others.",
    method: "POST",
    path: "/dashboards/{dashboardId}/widgets",
    tag: "Dashboards",
    effect: "write",
    successStatus: 201,
    input: z.object({
      config: widgetConfig,
      dashboardId,
      layout: widgetLayout.optional(),
      title: widgetTitle,
      type: widgetType,
    }),
    output: z.object({ widget: widgetSchema }),
    async run(context, input) {
      await requireDashboards(context);
      checkWidgetConfig(input.type, input.config);
      const widget = await addTelemetryDashboardWidget(context.organizationId, input.dashboardId, {
        config: input.config,
        layout: input.layout ?? defaultWidgetLayout(input.type),
        title: input.title,
        type: input.type,
      });
      if (!widget) throw dashboardNotFound();
      return { widget };
    },
  }),
  defineOperation({
    name: "update_dashboard_widget",
    summary: "Change a dashboard widget",
    description:
      "Changes a widget's title, settings, or position. `config` replaces all of the widget's settings, so include every setting to keep.",
    method: "PATCH",
    path: "/dashboards/{dashboardId}/widgets/{widgetId}",
    tag: "Dashboards",
    effect: "destructive",
    input: z.object({
      config: widgetConfig.optional(),
      dashboardId,
      layout: widgetLayout.optional(),
      title: widgetTitle.optional(),
      widgetId,
    }),
    output: z.object({ widget: widgetSchema }),
    async run(context, input) {
      await requireDashboards(context);
      if (input.config === undefined && input.layout === undefined && input.title === undefined) {
        throw new ManagementError(400, "Send a title, config, or layout to change.", "nothing_to_update");
      }
      if (input.config) {
        const dashboard = await requireDashboard(context, input.dashboardId);
        const existing = dashboard.widgets.find((widget) => widget.id === input.widgetId);
        if (!existing) throw widgetNotFound();
        checkWidgetConfig(existing.type, input.config);
      }
      const widget = await updateTelemetryDashboardWidget(context.organizationId, input.dashboardId, input.widgetId, {
        ...(input.config ? { config: input.config } : {}),
        ...(input.layout ? { layout: input.layout } : {}),
        ...(input.title ? { title: input.title } : {}),
      });
      if (!widget) throw widgetNotFound();
      return { widget };
    },
  }),
  defineOperation({
    name: "update_dashboard_layout",
    summary: "Move and resize dashboard widgets",
    description: "Sets the position and size of several widgets on one dashboard at once. Widgets left out keep their place.",
    method: "PATCH",
    path: "/dashboards/{dashboardId}/layout",
    tag: "Dashboards",
    effect: "write",
    input: z.object({
      dashboardId,
      widgets: z.array(z.object({ id: widgetId, layout: widgetLayout })).min(1).max(200),
    }),
    output: z.object({ dashboard: dashboardSchema }),
    async run(context, input) {
      await requireDashboards(context);
      if (!(await updateTelemetryDashboardLayout(context.organizationId, input.dashboardId, input.widgets))) {
        throw new ManagementError(404, "Dashboard or widget not found", "widget_not_found");
      }
      return { dashboard: withUrl(await requireDashboard(context, input.dashboardId)) };
    },
  }),
  defineOperation({
    name: "delete_dashboard_widget",
    summary: "Remove a dashboard widget",
    description: "Removes one widget from a dashboard.",
    method: "DELETE",
    path: "/dashboards/{dashboardId}/widgets/{widgetId}",
    tag: "Dashboards",
    effect: "destructive",
    input: z.object({ dashboardId, widgetId }),
    output: z.object({ deleted: z.literal(true) }),
    async run(context, input) {
      await requireDashboards(context);
      if (!(await deleteTelemetryDashboardWidget(context.organizationId, input.dashboardId, input.widgetId))) {
        throw widgetNotFound();
      }
      return { deleted: true as const };
    },
  }),
];
