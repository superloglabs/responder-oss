import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AgentDetailSkeleton,
  AgentListSkeleton,
  AgentSetupSkeleton,
  BillingSkeleton,
  IntegrationSettingsSkeleton,
  InvestigationDetailSkeleton,
  MemberListSkeleton,
  IssueDetailSkeleton,
  IssueListSkeleton,
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
