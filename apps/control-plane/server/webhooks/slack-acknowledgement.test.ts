import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addSlackReaction: vi.fn(),
  decryptCredentials: vi.fn(),
  failInvestigationSlackCard: vi.fn(),
  getSlackChannelConnection: vi.fn(),
  postSlackMessage: vi.fn(),
  reconcileCompletedInvestigationSlackCard: vi.fn(),
  recordInvestigationSlackMessage: vi.fn(),
  recordInvestigationSlackSource: vi.fn(),
  removeInvestigationSlackReply: vi.fn(),
  setInvestigationSlackReaction: vi.fn(),
  setSlackThreadStatus: vi.fn(),
  slackInvestigationCard: vi.fn(),
}));

vi.mock("../../../../packages/core/src/credentials/encryption.js", () => ({
  decryptCredentials: mocks.decryptCredentials,
}));
vi.mock("../../../../packages/core/src/db/integrations.js", () => ({
  getSlackChannelConnection: mocks.getSlackChannelConnection,
}));
vi.mock("../../../../packages/core/src/db/investigations.js", () => ({
  recordInvestigationSlackMessage: mocks.recordInvestigationSlackMessage,
  recordInvestigationSlackSource: mocks.recordInvestigationSlackSource,
  removeInvestigationSlackReply: mocks.removeInvestigationSlackReply,
  setInvestigationSlackReaction: mocks.setInvestigationSlackReaction,
}));
vi.mock("../../../../packages/core/src/integrations/slack.js", () => ({
  addSlackReaction: mocks.addSlackReaction,
  postSlackEphemeralMessage: vi.fn(),
  postSlackMessage: mocks.postSlackMessage,
  setSlackThreadStatus: mocks.setSlackThreadStatus,
}));
vi.mock("../../../../packages/core/src/integrations/slack-live-card.js", () => ({
  failInvestigationSlackCard: mocks.failInvestigationSlackCard,
  slackErrorLogFields: (error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof AggregateError
      ? {
          causes: error.errors.map((cause: unknown) =>
            cause instanceof Error ? cause.message : String(cause),
          ),
        }
      : {}),
  }),
  slackInvestigationCard: mocks.slackInvestigationCard,
}));
vi.mock("../../../../packages/core/src/integrations/slack-delivery.js", () => ({
  reconcileCompletedInvestigationSlackCard:
    mocks.reconcileCompletedInvestigationSlackCard,
}));

import { acknowledgeSlackAlert } from "./slack.js";

const input = {
  agentId: "13131313-1313-4313-8313-131313131313",
  channelId: "C123",
  integrationAccountId: "04040404-0404-4404-8404-040404040404",
  investigationId: "16161616-1616-4616-8616-161616161616",
  messageTimestamp: "1785500000.000100",
  organizationId: "03030303-0303-4303-8303-030303030303",
  threadTimestamp: "1785500000.000100",
  title: "Plant API error rate is elevated",
};

describe("Slack alert acknowledgement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSlackChannelConnection.mockResolvedValue({
      encryptedCredentials: "encrypted-slack-token",
    });
    mocks.decryptCredentials.mockReturnValue({ accessToken: "xoxb-test" });
    mocks.slackInvestigationCard.mockReturnValue({
      blocks: [{ type: "plan" }],
      text: "Investigating",
    });
    mocks.postSlackMessage.mockResolvedValue("1785500001.000200");
    mocks.addSlackReaction.mockResolvedValue(undefined);
    mocks.setSlackThreadStatus.mockResolvedValue(undefined);
    mocks.reconcileCompletedInvestigationSlackCard.mockResolvedValue(true);
    mocks.failInvestigationSlackCard.mockResolvedValue(true);
  });

  it("records the live message before slower Slack decoration and reconciles a fast completion", async () => {
    mocks.recordInvestigationSlackMessage.mockResolvedValue("resolved");

    await expect(acknowledgeSlackAlert(input)).resolves.toBeUndefined();

    expect(mocks.recordInvestigationSlackMessage).toHaveBeenCalledBefore(
      mocks.addSlackReaction,
    );
    expect(mocks.recordInvestigationSlackMessage).toHaveBeenCalledBefore(
      mocks.setSlackThreadStatus,
    );
    expect(mocks.recordInvestigationSlackMessage).toHaveBeenCalledBefore(
      mocks.reconcileCompletedInvestigationSlackCard,
    );
    expect(mocks.reconcileCompletedInvestigationSlackCard).toHaveBeenCalledWith(
      input.investigationId,
    );
    expect(mocks.recordInvestigationSlackMessage).toHaveBeenCalledWith(
      input.investigationId,
      "1785500001.000200",
      expect.objectContaining({
        authorName: "Responder",
        key: "investigation-status",
        text: "Investigating",
      }),
    );
    expect(mocks.setInvestigationSlackReaction).toHaveBeenCalledWith(
      input.investigationId,
      "eyes",
      true,
    );
  });

  it("reconciles a fast failure after recording the live message", async () => {
    mocks.recordInvestigationSlackMessage.mockResolvedValue("failed");

    await expect(acknowledgeSlackAlert(input)).resolves.toBeUndefined();

    expect(mocks.recordInvestigationSlackMessage).toHaveBeenCalledBefore(
      mocks.failInvestigationSlackCard,
    );
    expect(mocks.failInvestigationSlackCard).toHaveBeenCalledWith(
      input.investigationId,
    );
  });

  it("clears decoration when the investigation fails while decoration starts", async () => {
    mocks.recordInvestigationSlackMessage
      .mockResolvedValueOnce("investigating")
      .mockResolvedValueOnce("failed");

    await expect(acknowledgeSlackAlert(input)).resolves.toBeUndefined();

    expect(mocks.recordInvestigationSlackMessage).toHaveBeenCalledTimes(2);
    expect(mocks.setSlackThreadStatus).toHaveBeenCalledBefore(
      mocks.failInvestigationSlackCard,
    );
    expect(mocks.failInvestigationSlackCard).toHaveBeenCalledWith(
      input.investigationId,
    );
    expect(
      mocks.reconcileCompletedInvestigationSlackCard,
    ).not.toHaveBeenCalled();
  });

  it("logs a missing live message timestamp with investigation context", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.postSlackMessage.mockResolvedValue(null);

    await expect(acknowledgeSlackAlert(input)).rejects.toThrow(
      "Slack did not return the live investigation message timestamp",
    );

    expect(errorLog).toHaveBeenCalledWith(
      JSON.stringify({
        channelId: input.channelId,
        event: "investigation_slack_live_message_missing_timestamp",
        investigationId: input.investigationId,
      }),
    );
  });

  it("logs a failed live message record separately from Slack API failures", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.recordInvestigationSlackMessage.mockRejectedValue(
      new Error("database connection refused"),
    );

    await expect(acknowledgeSlackAlert(input)).rejects.toThrow(
      "Unable to fully acknowledge the Slack alert",
    );

    expect(errorLog).toHaveBeenCalledWith(
      JSON.stringify({
        error: "database connection refused",
        event: "investigation_slack_message_record_failed",
        investigationId: input.investigationId,
      }),
    );
  });

  it("logs the individual Slack causes when final reconciliation fails", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.recordInvestigationSlackMessage.mockResolvedValue("resolved");
    mocks.reconcileCompletedInvestigationSlackCard.mockRejectedValue(
      new AggregateError(
        [new Error("Slack chat.update failed (message_not_found)")],
        "Slack completed investigation reconciliation failed",
      ),
    );

    await expect(acknowledgeSlackAlert(input)).rejects.toThrow(
      "Unable to fully acknowledge the Slack alert",
    );

    expect(errorLog).toHaveBeenCalledWith(
      JSON.stringify({
        error: "Slack completed investigation reconciliation failed",
        causes: ["Slack chat.update failed (message_not_found)"],
        event: "investigation_slack_reconcile_failed",
        investigationId: input.investigationId,
      }),
    );
  });
});
