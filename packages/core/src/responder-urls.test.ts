import { describe, expect, it } from "vitest";
import {
  responderInvestigationUrl,
  responderIssueUrl,
} from "./responder-urls.js";

describe("Responder URLs", () => {
  it("preserves an application path prefix", () => {
    expect(
      responderIssueUrl("issue 1", "https://responder.example/app/"),
    ).toBe("https://responder.example/app/issues/issue%201");
  });

  it("rejects non-HTTP origins", () => {
    expect(() => responderIssueUrl("issue-1", "javascript:alert(1)"))
      .toThrow("Responder URLs must use HTTP or HTTPS");
  });

  it("builds an investigation URL with organization context", () => {
    expect(responderInvestigationUrl({
      agentId: "agent 1",
      investigationId: "investigation 1",
      organizationId: "organization 1",
      origin: "https://responder.example/app/",
    })).toBe(
      "https://responder.example/app/agents/agent%201/investigations/investigation%201?organization_id=organization+1",
    );
  });
});
