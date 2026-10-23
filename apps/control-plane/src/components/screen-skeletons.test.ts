import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AgentDetailSkeleton,
  AgentListSkeleton,
  AgentSettingsSkeleton,
  AgentSetupSkeleton,
  AlertDetailSkeleton,
  AppFrameSkeleton,
  BillingSkeleton,
  CardContentSkeleton,
  ChartSkeleton,
  DashboardSkeleton,
  DataTableSkeleton,
  DiffSkeleton,
  ErrorIssueSkeleton,
  ExplorerSkeleton,
  FormPageSkeleton,
  IntegrationRowsSkeleton,
  IntegrationSettingsSkeleton,
  InvestigationDetailSkeleton,
  IssueDetailSkeleton,
  IssueListSkeleton,
  ListSkeleton,
  MemberListSkeleton,
  PullRequestDetailSkeleton,
  PullRequestListSkeleton,
  ScanDetailSkeleton,
  SuggestionDetailSkeleton,
  SyntheticCheckSkeleton,
  TelemetryOverviewSkeleton,
  TelemetryPageSkeleton,
  TelemetrySetupSkeleton,
  TelemetrySourceSkeleton,
  TraceDetailSkeleton,
  TraceDrawerSkeleton,
  UsageCardsSkeleton,
  WorkspaceListSkeleton,
} from "./screen-skeletons";

const screens: Array<[ComponentType, string]> = [
  [AgentListSkeleton, "Loading agents…"],
  [IssueListSkeleton, "Loading issues…"],
  [AgentDetailSkeleton, "Loading agent…"],
  [IssueDetailSkeleton, "Loading issue…"],
  [InvestigationDetailSkeleton, "Loading investigation…"],
  [AgentSetupSkeleton, "Loading agent setup…"],
  [IntegrationSettingsSkeleton, "Loading integrations…"],
  [BillingSkeleton, "Loading billing…"],
  [MemberListSkeleton, "Loading members…"],
  [PullRequestListSkeleton, "Loading pull requests…"],
  [PullRequestDetailSkeleton, "Loading pull request…"],
  [AgentSettingsSkeleton, "Loading agent settings…"],
  [AlertDetailSkeleton, "Loading alert…"],
  [AppFrameSkeleton, "Loading Superlog…"],
  [DashboardSkeleton, "Loading dashboard…"],
  [ErrorIssueSkeleton, "Loading error…"],
  [ScanDetailSkeleton, "Loading scan…"],
  [SuggestionDetailSkeleton, "Loading suggestion…"],
  [SyntheticCheckSkeleton, "Loading check…"],
  [TelemetryOverviewSkeleton, "Loading overview…"],
  [TelemetryPageSkeleton, "Loading telemetry…"],
  [TelemetrySetupSkeleton, "Loading telemetry sources…"],
  [TelemetrySourceSkeleton, "Loading setup…"],
  [TraceDetailSkeleton, "Loading trace…"],
  [TraceDrawerSkeleton, "Loading trace…"],
  [UsageCardsSkeleton, "Loading usage…"],
  [WorkspaceListSkeleton, "Loading workspaces…"],
  [() => createElement(ChartSkeleton, { label: "Loading chart…" }), "Loading chart…"],
  [
    () => createElement(DataTableSkeleton, { columns: [{ header: "Name", key: "name" }], label: "Loading rows…" }),
    "Loading rows…",
  ],
  [() => createElement(DiffSkeleton, { label: "Loading diff…" }), "Loading diff…"],
  [() => createElement(ExplorerSkeleton, { label: "Loading logs…" }), "Loading logs…"],
  [() => createElement(FormPageSkeleton, { className: "alertPage", label: "Loading form…" }), "Loading form…"],
  [() => createElement(IntegrationRowsSkeleton, { label: "Loading integrations…" }), "Loading integrations…"],
  [() => createElement(CardContentSkeleton, { label: "Loading setup…" }), "Loading setup…"],
  [() => createElement(ListSkeleton, { label: "Loading list…" }), "Loading list…"],
];

describe("screen skeletons", () => {
  it.each(screens)("announces its loading state and hides decorative placeholders", (Screen, label) => {
    const markup = renderToStaticMarkup(createElement(Screen));

    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain(label);
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain("dsSkeleton");
  });
});
