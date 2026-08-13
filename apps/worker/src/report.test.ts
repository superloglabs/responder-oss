import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { submitInvestigationReport } from "@responder/core/db/issues";
import { saveInvestigationReplayReport } from "@responder/core/db/investigations";
import { deliverInvestigationToSlack } from "@responder/core/integrations/slack-delivery";
import { embedNewIssues } from "./issue-embeddings.js";
import {
  captureInvestigationReplayReport,
  createCaptureInvestigationReplayReportTool,
  createSubmitInvestigationReportTool,
  deliverCompletedInvestigationWithWarnings,
  submitInvestigationReportForRun,
} from "./report.js";

vi.mock("@responder/core/db/issues", () => ({
  submitInvestigationReport: vi.fn(),
}));
vi.mock("@responder/core/db/investigations", () => ({
  saveInvestigationReplayReport: vi.fn(),
}));
vi.mock("@responder/core/integrations/slack-delivery", () => ({
  deliverInvestigationToSlack: vi.fn(),
}));
vi.mock("./issue-embeddings.js", () => ({
  embedNewIssues: vi.fn(),
}));

describe("investigation report submission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("saves the structured report without delivering it early", async () => {
    vi.mocked(submitInvestigationReport).mockResolvedValue({
      automaticPullRequestIssueIds: [],
      automaticPullRequestRequestIds: [],
      issues: [
        {
          id: "7ad47787-0efa-4ce3-b1d7-2f14bcfcd4e9",
          title: "Broken route",
          description: "The route throws.",
          severity: "SEV-2",
          remediation: "Handle the missing value.",
        },
      ],
      markdown: "saved markdown",
      report: {
        schemaVersion: 1,
        headline: "Broken route",
        summary: "The route failed.",
        issues: [],
      },
    });
    vi.mocked(deliverInvestigationToSlack).mockResolvedValue([]);
    vi.mocked(embedNewIssues).mockResolvedValue([
      { model: "openai/text-embedding-3-small", vector: [0.1, 0.2] },
    ]);

    const report = {
      schemaVersion: 1 as const,
      headline: "Broken route",
      summary: "The route failed.",
      issues: [
        {
          resolution: "new" as const,
          title: "Broken route",
          description: "The route throws.",
          severity: "SEV-2" as const,
          remediation: "Handle the missing value.",
          evidence: [
            {
              source: "github" as const,
              title: "Missing check",
              detail: "The handler reads an optional value without checking it.",
              file: "src/route.ts",
              line: 42,
            },
          ],
        },
      ],
    };

    await expect(
      submitInvestigationReportForRun({
        investigationId: "investigation-id",
        organizationId: "organization-id",
        report,
      }),
    ).resolves.toEqual({
      accepted: true,
      automaticPullRequestIssueIds: [],
      deliveryWarnings: [],
      issueIds: ["7ad47787-0efa-4ce3-b1d7-2f14bcfcd4e9"],
      instruction: "The report was saved.",
      slackMarkdown: "saved markdown",
    });
    expect(submitInvestigationReport).toHaveBeenCalledWith({
      investigationId: "investigation-id",
      organizationId: "organization-id",
      submission: {
        report,
        newIssueEmbeddings: [
          {
            model: "openai/text-embedding-3-small",
            vector: [0.1, 0.2],
          },
        ],
      },
    });
    expect(deliverInvestigationToSlack).not.toHaveBeenCalled();
  });

  it("hands automatic pull request requests to separate remediation jobs", async () => {
    const onAutomaticPullRequestRequests = vi.fn().mockResolvedValue(undefined);
    vi.mocked(submitInvestigationReport).mockResolvedValue({
      automaticPullRequestIssueIds: [
        "7ad47787-0efa-4ce3-b1d7-2f14bcfcd4e9",
      ],
      automaticPullRequestRequestIds: [
        "4614c371-a4a3-4342-a9a8-36e526377345",
      ],
      issues: [],
      markdown: "saved markdown",
      report: {
        schemaVersion: 1,
        headline: "Broken route",
        summary: "The route failed.",
        issues: [],
      },
    });
    vi.mocked(deliverInvestigationToSlack).mockResolvedValue([]);
    vi.mocked(embedNewIssues).mockResolvedValue([]);

    const reportTool = createSubmitInvestigationReportTool({
      investigationId: "investigation-id",
      organizationId: "organization-id",
      onAutomaticPullRequestRequests,
    });

    await expect(
      reportTool.invoke(
        undefined as never,
        JSON.stringify({
          schemaVersion: 1,
          headline: "Broken route",
          summary: "The route failed.",
          issues: [],
        }),
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        instruction: expect.stringContaining("Separate remediation jobs"),
      }),
    );
    expect(onAutomaticPullRequestRequests).toHaveBeenCalledWith([
      "4614c371-a4a3-4342-a9a8-36e526377345",
    ]);
  });

  it("treats completed Slack delivery failures as warnings", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(deliverInvestigationToSlack).mockImplementation(async () => {
      throw new Error("Slack lookup failed");
    });

    await expect(
      deliverCompletedInvestigationWithWarnings("investigation-id"),
    ).resolves.toEqual(["Slack lookup failed"]);
    expect(JSON.parse(String(consoleError.mock.calls[0]?.[0]))).toEqual(
      expect.objectContaining({
        error: "Slack lookup failed",
        errorStack: expect.stringContaining("Slack lookup failed"),
        event: "investigation_slack_delivery_failed",
        investigationId: "investigation-id",
      }),
    );
  });

  it("supports direct report submission without a remediation callback", async () => {
    vi.mocked(submitInvestigationReport).mockResolvedValue({
      automaticPullRequestIssueIds: [],
      automaticPullRequestRequestIds: [],
      issues: [],
      markdown: "saved markdown",
      report: {
        schemaVersion: 1,
        headline: "No issue",
        summary: "No issue was found.",
        issues: [],
      },
    });
    vi.mocked(deliverInvestigationToSlack).mockResolvedValue([]);
    vi.mocked(embedNewIssues).mockResolvedValue([]);

    await expect(
      submitInvestigationReportForRun({
        investigationId: "investigation-id",
        organizationId: "organization-id",
        report: {
          schemaVersion: 1,
          headline: "No issue",
          summary: "No issue was found.",
          issues: [],
        },
      }),
    ).resolves.toEqual(expect.objectContaining({ accepted: true }));
  });

  it("captures a replay without writing issues or delivering to Slack", async () => {
    const report = {
      schemaVersion: 1 as const,
      headline: "Current-data replay",
      summary: "Sentry telemetry confirms the regression.",
      issues: [],
    };

    await expect(
      captureInvestigationReplayReport({
        investigationId: "replay-id",
        organizationId: "organization-id",
        report,
      }),
    ).resolves.toEqual({
      accepted: true,
      automaticPullRequestIssueIds: [],
      deliveryWarnings: [],
      issueIds: [],
      instruction: "The report was saved.",
    });
    expect(saveInvestigationReplayReport).toHaveBeenCalledWith({
      investigationId: "replay-id",
      organizationId: "organization-id",
      report,
    });
    expect(submitInvestigationReport).not.toHaveBeenCalled();
    expect(deliverInvestigationToSlack).not.toHaveBeenCalled();
    expect(embedNewIssues).not.toHaveBeenCalled();
  });

  it("captures replay reports without scheduling pull request fixes", async () => {
    const existingIssueId = "7ad47787-0efa-4ce3-b1d7-2f14bcfcd4e9";
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
    const report = {
      schemaVersion: 1 as const,
      headline: "Two regressions",
      summary: "The current run found both regressions.",
      issues: [
        {
          resolution: "existing" as const,
          issueId: existingIssueId,
          evidence: [
            {
              source: "sentry" as const,
              title: "Repeated exception",
              detail: "The same exception is still occurring.",
            },
          ],
        },
        {
          resolution: "new" as const,
          title: "New regression",
          description: "A new path fails.",
          severity: "SEV-2" as const,
          remediation: "Handle the new path.",
          evidence: [
            {
              source: "github" as const,
              title: "Unchecked input",
              detail: "The input is used without validation.",
            },
          ],
        },
      ],
    };

    const result = await captureInvestigationReplayReport({
      investigationId: "replay-id",
      organizationId: "organization-id",
      report,
    });

    expect(result.issueIds).toEqual([existingIssueId]);
    expect(result.automaticPullRequestIssueIds).toEqual([]);
    expect(result.instruction).toBe("The report was saved.");
    expect(consoleInfo).toHaveBeenCalledWith(
      JSON.stringify({
        event: "investigation_replay_report_captured",
        investigationId: "replay-id",
        organizationId: "organization-id",
      }),
    );

    const normalTool = createSubmitInvestigationReportTool({
      investigationId: "normal-id",
      organizationId: "organization-id",
    });
    const replayTool = createCaptureInvestigationReplayReportTool({
      investigationId: "replay-id",
      organizationId: "organization-id",
    });
    expect(replayTool.description).toBe(normalTool.description);
    expect(replayTool.name).toBe(normalTool.name);
  });

  it("logs replay report persistence failures with tenant context", async () => {
    const failure = new Error("database unavailable");
    vi.mocked(saveInvestigationReplayReport).mockRejectedValueOnce(failure);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      captureInvestigationReplayReport({
        investigationId: "replay-id",
        organizationId: "organization-id",
        report: {
          schemaVersion: 1,
          headline: "Replay failed",
          summary: "The replay report could not be saved.",
          issues: [],
        },
      }),
    ).rejects.toBe(failure);
    expect(consoleError).toHaveBeenCalledWith(
      JSON.stringify({
        error: "database unavailable",
        event: "investigation_replay_report_capture_failed",
        investigationId: "replay-id",
        organizationId: "organization-id",
      }),
    );
  });
});
