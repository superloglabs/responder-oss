import { describe, expect, it, vi } from "vitest";
import {
  linearAgentDelivery,
  linearFailureMessage,
} from "./linear-agent-delivery.js";

const investigationId = "10000000-0000-4000-8000-000000000000";
const request = {
  agentId: "20000000-0000-4000-8000-000000000000",
  provider: "linear" as const,
  externalEventId: "session-1:agent",
  title: "ENG-1: Checkout returns 503",
  body: "Fix it.",
  attributes: {
    integrationAccountId: "30000000-0000-4000-8000-000000000000",
    linearAgentSessionId: "session-1",
  },
};
const target = {
  agentSessionId: "session-1",
  integrationAccountId: "30000000-0000-4000-8000-000000000000",
  organizationId: "organization-1",
};

describe("Linear agent delivery", () => {
  it("only handles Linear requests", () => {
    expect(linearAgentDelivery({
      investigationId,
      organizationId: "organization-1",
      request: { ...request, provider: "slack" },
    })).toBeNull();
  });

  it("throttles progress thoughts and skips repeats", async () => {
    let at = 0;
    const send = vi.fn().mockResolvedValue(undefined);
    const delivery = linearAgentDelivery({
      investigationId,
      now: () => at,
      organizationId: "organization-1",
      request,
      send,
    })!;

    at = 10_000;
    await delivery.progress("Reading the request.");
    at = 11_000;
    await delivery.progress("Thinking.");
    at = 14_000;
    await delivery.progress("Reading the request.");
    at = 20_000;
    await delivery.progress("Reading the request.");
    at = 20_500;
    await delivery.progress("Writing the reply.", { force: true });

    expect(send.mock.calls.map(([call]) => call.content.body)).toEqual([
      "Reading the request.",
      "Writing the reply.",
    ]);
    expect(send).toHaveBeenCalledWith({
      ...target,
      content: { type: "thought", body: "Writing the reply." },
      ephemeral: true,
    });
  });

  it("posts the reply and failure with the investigation ID", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const delivery = linearAgentDelivery({
      investigationId,
      organizationId: "organization-1",
      request,
      send,
    })!;

    await delivery.respond("Opened acme/api#12.");
    await delivery.fail();

    expect(send).toHaveBeenNthCalledWith(1, {
      ...target,
      content: { type: "response", body: "Opened acme/api#12." },
      id: investigationId,
    });
    expect(send).toHaveBeenNthCalledWith(2, {
      ...target,
      content: { type: "error", body: linearFailureMessage },
      id: investigationId,
    });
  });
});
