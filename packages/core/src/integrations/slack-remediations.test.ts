import { describe, expect, it } from "vitest";
import {
  parseSlackRemediationActionValue,
  slackCodeChangeUrl,
  slackIssuePullRequestMessage,
  slackRemediationActionValue,
  slackRemediationCarousel,
} from "./slack-remediations.js";

const issueId = "07070707-0707-4707-8707-070707070707";
const codeRemediation = {
  id: "24242424-2424-4424-8424-242424242424",
  type: "code_change" as const,
  title: "Restore the plant guard",
  description: "Handle plants without a configured color.",
  changes: [{ repository: null, diff: "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n+b" }],
};
const externalRemediation = {
  id: "26262626-2626-4626-8626-262626262626",
  type: "external_action" as const,
  title: "Update the production palette",
  description: "Change the configured petal color.",
  agentPrompt: "Set the production petal color to silver.",
};

describe("Slack remediation cards", () => {
  it("renders every remediation in a selectable carousel", () => {
    const blocks = slackRemediationCarousel({
      canCreatePullRequest: true,
      issueId,
      remediations: [codeRemediation, externalRemediation],
    });

    expect(blocks).toEqual([
      expect.objectContaining({ type: "header" }),
      expect.objectContaining({
        type: "carousel",
        elements: [
          expect.objectContaining({
            title: expect.objectContaining({ text: codeRemediation.title }),
            subtitle: expect.objectContaining({ text: "Code change" }),
            actions: expect.arrayContaining([
              expect.objectContaining({
                action_id: "view_code_change",
                url: slackCodeChangeUrl(issueId, codeRemediation.id),
              }),
              expect.objectContaining({
                action_id: "create_issue_pull_request",
                value: slackRemediationActionValue(
                  issueId,
                  codeRemediation.id,
                ),
              }),
            ]),
          }),
          expect.objectContaining({
            title: expect.objectContaining({ text: externalRemediation.title }),
            subtitle: expect.objectContaining({ text: "External action" }),
            actions: [
              expect.objectContaining({
                action_id: "copy_issue_prompt",
                value: slackRemediationActionValue(
                  issueId,
                  externalRemediation.id,
                ),
              }),
            ],
          }),
        ],
      }),
    ]);
    expect(JSON.stringify(blocks)).not.toContain(
      "You can use any of these remediations.",
    );
  });

  it("keeps card title and body text within Slack's 200-character limit", () => {
    const blocks = slackRemediationCarousel({
      canCreatePullRequest: true,
      issueId,
      remediations: [{
        ...codeRemediation,
        title: "T".repeat(250),
        description: "D".repeat(250),
      }],
    });
    const carousel = blocks[1] as {
      elements: Array<{ body: { text: string }; title: { text: string } }>;
    };

    expect(carousel.elements[0]?.title.text).toHaveLength(200);
    expect(carousel.elements[0]?.title.text.endsWith("…")).toBe(true);
    expect(carousel.elements[0]?.body.text).toHaveLength(200);
    expect(carousel.elements[0]?.body.text.endsWith("…")).toBe(true);
  });

  it("round-trips the selected issue and remediation IDs", () => {
    expect(
      parseSlackRemediationActionValue(
        slackRemediationActionValue(issueId, codeRemediation.id),
      ),
    ).toEqual({ issueId, remediationId: codeRemediation.id });
    expect(parseSlackRemediationActionValue(issueId)).toBeNull();
  });

  it("deep-links code changes to the selected remediation diff", () => {
    const url = new URL(slackCodeChangeUrl(issueId, codeRemediation.id));
    expect(url.pathname).toBe(`/issues/${issueId}`);
    expect(url.searchParams.get("codeChange")).toBe(codeRemediation.id);
    expect(url.hash).toBe(`#remediation-${codeRemediation.id}`);
  });

  it("shows the selected remediation and live pull request state", () => {
    const investigationId = "16161616-1616-4616-8616-161616161616";
    const message = slackIssuePullRequestMessage({
      failureReason: null,
      issueId,
      issueSeverity: "SEV-2",
      issueTitle: "Plant API returns HTTP 500",
      pullRequestNumber: 42,
      pullRequestUrl: "https://github.com/example/plants/pull/42",
      repositoryFullName: "example/plants",
      requestId: "23232323-2323-4323-8323-232323232323",
      selectedRemediation: codeRemediation,
      status: "created",
    }, investigationId);

    expect(message.text).toContain("Pull request: Open");
    expect(message.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "carousel",
          elements: [
            expect.objectContaining({
              block_id: "pull-request-23232323-2323-4323-8323-232323232323",
              subtitle: expect.objectContaining({ text: "Open" }),
              actions: expect.arrayContaining([
                expect.objectContaining({
                  action_id: "open_pull_request",
                  url: "https://github.com/example/plants/pull/42",
                }),
              ]),
            }),
          ],
        }),
        expect.objectContaining({
          type: "context_actions",
          block_id: expect.stringMatching(
            new RegExp(`^investigation_feedback_${investigationId}_`),
          ),
        }),
      ]),
    );
  });
});
