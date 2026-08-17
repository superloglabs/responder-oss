import { describe, expect, it } from "vitest";
import { linearTicketAgentModel } from "./linear-ticket-job.js";

describe("Linear ticket agent model", () => {
  it("uses an explicitly saved model", () => {
    expect(linearTicketAgentModel("gpt-5.7", {})).toBe("gpt-5.7");
  });

  it("resolves the instance default like the investigation agent", () => {
    expect(linearTicketAgentModel("instance/default", {
      OPENAI_AGENT_MODEL: "gpt-5.6-sol",
    })).toBe("gpt-5.6-sol");
  });
});
