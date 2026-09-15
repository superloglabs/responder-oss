import { describe, expect, it } from "vitest";
import { defaultInvestigationPromptParts, renderInvestigationPromptPart } from "./prompt-parts.js";

describe("runtime profile prompt sections", () => {
  it("uses defaults for omitted sections and preserves explicit empty overrides", () => {
    expect(renderInvestigationPromptPart("sentry")).toBe(defaultInvestigationPromptParts.sentry);
    expect(renderInvestigationPromptPart("sentry", { sentry: "" })).toBe("");
    expect(renderInvestigationPromptPart("sentry", { sentry: "Inspect recent events." })).toBe("Inspect recent events.");
  });

  it("substitutes context once without interpreting inserted content", () => {
    expect(renderInvestigationPromptPart("aws", { aws: "Accounts: {{value1}} / {{value1}}" }, { value1: "customer {{value1}} $&" }))
      .toBe("Accounts: customer {{value1}} $& / customer {{value1}} $&");
  });
});
