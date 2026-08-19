import { describe, expect, it } from "vitest";
import { responderIssueUrl } from "./responder-urls.js";

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
});
