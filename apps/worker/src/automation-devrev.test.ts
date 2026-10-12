import { describe, expect, it, vi } from "vitest";
import { decryptCredentials } from "@responder/core/credentials/encryption";
import { commentAutomationRunOnDevRevTicket, devrevTicketOf } from "./automation-devrev.js";

vi.mock("@responder/core/credentials/encryption", () => ({ decryptCredentials: vi.fn() }));

const ticket = {
  integrationAccountId: "63636363-6363-4363-8363-636363636363",
  ticketId: "don:core:dvrv-us-1:devo/1abc:ticket/42",
};

describe("devrevTicketOf", () => {
  it("reads the ticket only from a DevRev trigger", () => {
    expect(devrevTicketOf({ attributes: { ...ticket, displayId: "TKT-42" }, provider: "devrev" })).toEqual(ticket);
    expect(devrevTicketOf({ attributes: ticket, provider: "slack" })).toBeNull();
    expect(devrevTicketOf({ attributes: { integrationAccountId: "not-an-id", ticketId: "x" }, provider: "devrev" })).toBeNull();
  });
});

describe("commentAutomationRunOnDevRevTicket", () => {
  const input = {
    automationId: "31313131-3131-4131-8131-313131313131",
    automationName: "Ticket triage",
    environment: { RESPONDER_APP_URL: "https://responder.example" },
    organizationId: "organization-1",
    outcome: { message: "The payment service is down.", status: "succeeded" as const },
    runId: "41414141-4141-4141-8141-414141414141",
    ticket,
  };

  it("posts the run's result with the connection's token", async () => {
    vi.mocked(decryptCredentials).mockReturnValue({ authType: "personal_access_token", token: "token" });
    const comment = vi.fn().mockResolvedValue(undefined);
    const getAccount = vi.fn().mockResolvedValue({ encryptedCredentials: "encrypted" });

    await commentAutomationRunOnDevRevTicket(input, { comment, getAccount });

    expect(getAccount).toHaveBeenCalledWith({
      integrationAccountId: ticket.integrationAccountId,
      organizationId: "organization-1",
      provider: "devrev",
    });
    expect(comment).toHaveBeenCalledWith({
      body: expect.stringMatching(/^\*\*Ticket triage\*\* finished\.\n\nThe payment service is down\.\n\n\[View run\]\(https:\/\/responder\.example\/.+\)$/u),
      ticketId: ticket.ticketId,
      token: "token",
    });
  });

  it("fails when the connection is gone", async () => {
    await expect(commentAutomationRunOnDevRevTicket(input, {
      comment: vi.fn(),
      getAccount: vi.fn().mockResolvedValue(null),
    })).rejects.toThrow("The DevRev connection is unavailable");
  });
});
