import { describe, expect, it, vi } from "vitest";
import { SlackApiError } from "./slack.js";
import {
  redeliverInvestigationSlackIssue,
  slackCompletedInvestigationCard,
  slackDeliveryClientMessageId,
  slackDeliveryErrorMessage,
  slackInvestigationSummaryMessage,
  slackIssueFollowupMessage,
  slackIssueMessage,
} from "./slack-delivery.js";

describe("Slack issue delivery", () => {
  it("keeps the completed investigation card focused on the trace", () => {
    const investigationId = "16161616-1616-4616-8616-161616161616";
    const message = slackCompletedInvestigationCard({
      agentId: "13131313-1313-4313-8313-131313131313",
      executionMode: "standard",
      investigationId,
      title: "Plant API error rate is elevated",
      traceItems: [],
    });

    expect(message.blocks).toEqual([
      expect.objectContaining({ type: "plan", title: "Trace" }),
    ]);
  });

  it("keeps feedback controls off the final summary", () => {
    const message = slackInvestigationSummaryMessage({
      issueCount: 0,
      summary: "The alert was transient.",
    });

    expect(message.text).toBe(
      "✅ *No issues identified.* The alert was transient.",
    );
    expect(message.blocks).toEqual([{
      type: "section",
      text: { type: "mrkdwn", text: message.text },
    }]);
  });

  it("uses stable, destination-specific message IDs for retry deduplication", () => {
    const first = slackDeliveryClientMessageId(
      "job-id",
      "source:C123:issue:issue-id",
    );

    expect(first).toBe(
      slackDeliveryClientMessageId(
        "job-id",
        "source:C123:issue:issue-id",
      ),
    );
    expect(first).not.toBe(
      slackDeliveryClientMessageId(
        "job-id",
        "output:C123:issue:issue-id",
      ),
    );
    expect(first).not.toBe(
      slackDeliveryClientMessageId(
        "manual-rerun-job-id",
        "source:C123:issue:issue-id",
      ),
    );
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("includes safe Slack response diagnostics in delivery warnings", () => {
    const warning = slackDeliveryErrorMessage(
      new AggregateError(
        [
          new SlackApiError("chat.postMessage", "http_200", [
            "Slack returned invalid JSON (status=200, content-type=text/plain, bytes=12); body=bad response",
          ]),
        ],
        "Slack source thread delivery failed",
      ),
    );

    expect(warning).toContain("Slack source thread delivery failed");
    expect(warning).toContain("chat.postMessage http_200");
    expect(warning).toContain("Slack returned invalid JSON");
  });

  it("redelivers only the selected issue to its source thread", async () => {
    const postMessage = vi.fn().mockResolvedValue("1785500001.000200");
    const recordReply = vi.fn().mockResolvedValue(undefined);
    const registerPullRequestMessage = vi.fn().mockResolvedValue(undefined);
    const issue = {
      id: "07070707-0707-4707-8707-070707070707",
      title: "Organization provisioning race",
      description: "The first request failed.",
      rootCause: "Provisioning was still running.",
      timeline: [],
      severity: "SEV-2" as const,
      remediation: "Wait for provisioning.",
      remediations: [],
      relationship: "new" as const,
      evidence: [],
      pullRequest: null,
    };

    await expect(
      redeliverInvestigationSlackIssue(
        {
          deliveryRunId: "backfill-2026-08-26",
          investigationId: "08080808-0808-4808-8808-080808080808",
          issueId: issue.id,
        },
        {
          getContext: vi.fn().mockResolvedValue({
            investigationId: "08080808-0808-4808-8808-080808080808",
            issues: [issue],
            prMode: "manual",
            source: {
              channelId: "C123",
              encryptedCredentials:
                "not-read-because-the-credential-parser-is-covered-separately",
              integrationAccountId: "09090909-0909-4909-8909-090909090909",
              messageTimestamp: null,
              reactionTimestamp: "1785500000.000100",
              threadTimestamp: "1785500000.000100",
            },
          } as never),
          getDetachedIssue: vi.fn().mockResolvedValue(null),
          postMessage,
          recordReply,
          registerPullRequestMessage,
          resolveAccessToken: vi.fn().mockReturnValue("xoxb-test"),
        },
      ),
    ).resolves.toEqual({
      issueId: issue.id,
      messageTimestamp: "1785500001.000200",
    });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: "xoxb-test",
        channelId: "C123",
        clientMessageId: slackDeliveryClientMessageId(
          "backfill-2026-08-26",
          `source:C123:issue:${issue.id}`,
        ),
        threadTimestamp: "1785500000.000100",
      }),
    );
    expect(registerPullRequestMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "C123",
        issue,
        messageTimestamp: "1785500001.000200",
      }),
    );
    expect(recordReply).toHaveBeenCalledWith(
      "08080808-0808-4808-8808-080808080808",
      expect.objectContaining({
        key: `issue:${issue.id}`,
        slackTimestamp: "1785500001.000200",
      }),
    );
  });

  it("requires an explicit flag to redeliver a detached historical issue", async () => {
    const issue = {
      id: "07070707-0707-4707-8707-070707070707",
      title: "Historical delivery failure",
      description: "Slack rejected the original issue card.",
      rootCause: "The card body exceeded Slack's limit.",
      timeline: [],
      severity: "SEV-2" as const,
      remediation: "Truncate card bodies.",
      remediations: [],
      relationship: "new" as const,
      evidence: [],
      pullRequest: null,
    };
    const getDetachedIssue = vi.fn().mockResolvedValue(issue);
    const postMessage = vi.fn().mockResolvedValue("1785500002.000300");
    const dependencies = {
      getContext: vi.fn().mockResolvedValue({
        investigationId: "08080808-0808-4808-8808-080808080808",
        issues: [],
        prMode: "manual",
        source: {
          channelId: "C123",
          encryptedCredentials: "encrypted",
          integrationAccountId: "09090909-0909-4909-8909-090909090909",
          messageTimestamp: null,
          reactionTimestamp: "1785500000.000100",
          threadTimestamp: "1785500000.000100",
        },
      } as never),
      getDetachedIssue,
      postMessage,
      recordReply: vi.fn().mockResolvedValue(undefined),
      registerPullRequestMessage: vi.fn().mockResolvedValue(undefined),
      resolveAccessToken: vi.fn().mockReturnValue("xoxb-test"),
    };

    await expect(
      redeliverInvestigationSlackIssue(
        {
          deliveryRunId: "backfill-2026-08-27",
          investigationId: "08080808-0808-4808-8808-080808080808",
          issueId: issue.id,
        },
        dependencies,
      ),
    ).rejects.toThrow("is not available for investigation");
    expect(getDetachedIssue).not.toHaveBeenCalled();

    await expect(
      redeliverInvestigationSlackIssue(
        {
          allowDetachedIssue: true,
          deliveryRunId: "backfill-2026-08-27",
          investigationId: "08080808-0808-4808-8808-080808080808",
          issueId: issue.id,
        },
        dependencies,
      ),
    ).resolves.toEqual({
      issueId: issue.id,
      messageTimestamp: "1785500002.000300",
    });
    expect(getDetachedIssue).toHaveBeenCalledWith({
      investigationId: "08080808-0808-4808-8808-080808080808",
      issueId: issue.id,
    });
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it("hides root cause and timeline and adds feedback to the issue message", () => {
    const investigationId = "16161616-1616-4616-8616-161616161616";
    const message = slackIssueMessage({
      id: "07070707-0707-4707-8707-070707070707",
      title: "Organization provisioning race",
      description: "The first authenticated request failed before the organization existed.",
      rootCause: "An authentication change redirected new users before organization provisioning completed.",
      timeline: [
        {
          title: "User logged in",
          description: "The user completed authentication and entered the application.",
        },
        {
          title: "User opened the dashboard",
          description: "The dashboard requested organization-scoped data before provisioning completed.",
        },
        {
          title: "Request failed",
          description: "The API could not resolve an organization and returned a 500 response.",
        },
      ],
      severity: "SEV-2",
      remediation: "Wait for organization provisioning before redirecting the user.",
      remediations: [],
      pullRequest: null,
      relationship: "new",
      evidence: [],
    }, investigationId);

    expect(message.text).not.toContain("Root cause");
    expect(message.text).not.toContain("Timeline");
    expect(message.blocks).toEqual([
      expect.objectContaining({
        type: "section",
        text: expect.objectContaining({
          text: expect.not.stringContaining("*Root cause*"),
        }),
      }),
      expect.objectContaining({ type: "actions" }),
      expect.objectContaining({
        type: "context_actions",
        block_id: expect.stringMatching(
          new RegExp(`^investigation_feedback_${investigationId}_`),
        ),
      }),
    ]);
  });

  it("shows every proposed remediation in a carousel", () => {
    const issueId = "07070707-0707-4707-8707-070707070707";
    const message = slackIssueMessage({
      id: issueId,
      title: "Plant colors are stale",
      description: "The rendered petals use the old color.",
      rootCause: "The palette and component defaults disagree.",
      timeline: [{
        title: "Palette changed",
        description: "The production palette changed before the component.",
      }],
      severity: "SEV-3",
      remediation: "Update the component or production palette.",
      remediations: [
        {
          id: "24242424-2424-4424-8424-242424242424",
          type: "code_change",
          title: "Update the component default",
          description: "Use the configured petal color.",
          changes: [{ repository: null, diff: "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n+b" }],
        },
        {
          id: "26262626-2626-4626-8626-262626262626",
          type: "external_action",
          title: "Update the production palette",
          description: "Set the petal color in production.",
          agentPrompt: "Set the production petal color to silver.",
        },
      ],
      pullRequest: null,
      relationship: "new",
      evidence: [],
    }, "16161616-1616-4616-8616-161616161616", true);

    expect(message.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "carousel",
          elements: [
            expect.objectContaining({
              subtitle: expect.objectContaining({ text: "Code change" }),
            }),
            expect.objectContaining({
              subtitle: expect.objectContaining({ text: "External action" }),
            }),
          ],
        }),
      ]),
    );
  });

  it("renders updated remediations with the same actionable carousel", () => {
    const issueId = "07070707-0707-4707-8707-070707070707";
    const codeRemediationId = "24242424-2424-4424-8424-242424242424";
    const externalRemediationId = "26262626-2626-4626-8626-262626262626";
    const message = slackIssueFollowupMessage({
      context: {
        investigationId: "16161616-1616-4616-8616-161616161616",
        issues: [{
          id: issueId,
          title: "Malformed cart payload",
          description: "Malformed payloads fail during parsing.",
          rootCause: "Input is parsed before it is validated.",
          timeline: [],
          severity: "SEV-2",
          remediation: "Validate the payload, warn, and return 400.",
          remediations: [{
            id: codeRemediationId,
            type: "code_change",
            title: "Validate before parsing",
            description: "Return a structured 400 for malformed input.",
            changes: [{ repository: null, diff: "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n+b" }],
          }, {
            id: externalRemediationId,
            type: "external_action",
            title: "Adjust the monitor",
            description: "Exclude expected validation warnings.",
            agentPrompt: "Exclude warning-level validation logs from the monitor.",
          }],
          pullRequest: null,
          relationship: "new",
          evidence: [],
        }],
        prMode: "manual",
        source: null,
        output: null,
        organizationId: "17171717-1717-4717-8717-171717171717",
      } as never,
      response: "I revised the proposal to retain a warning.",
      updatedIssueIds: [issueId],
    });

    expect(message.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "carousel",
        elements: [
          expect.objectContaining({
            actions: expect.arrayContaining([
              expect.objectContaining({
                action_id: "create_issue_pull_request",
                text: expect.objectContaining({ text: "Open PR" }),
              }),
            ]),
          }),
          expect.objectContaining({
            actions: expect.arrayContaining([
              expect.objectContaining({
                action_id: "copy_issue_prompt",
                text: expect.objectContaining({ text: "Copy prompt" }),
              }),
            ]),
          }),
        ],
      }),
    ]));
  });
});
