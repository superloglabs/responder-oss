import { describe, expect, it } from "vitest";
import { investigationPrompt, investigationRequestSchema } from "./input.js";

describe("investigation input", () => {
  it("normalizes a provider event into a bounded investigation", () => {
    const parsed = investigationRequestSchema.parse({
      agentId: "4a45b497-ae82-4c48-b1df-d6057c0f4cef",
      provider: "sentry",
      externalEventId: "event-1842",
      title: "Elevated checkout errors",
      body: "Timeouts started after the latest deploy.",
      sourceUrl: "https://sentry.example/issues/1842",
    });

    const prompt = investigationPrompt(parsed);

    expect(prompt).toContain("# sentry event");
    expect(prompt).toContain(parsed.title);
    expect(prompt).toContain(parsed.body);
  });

  it("rejects unknown providers", () => {
    expect(() =>
      investigationRequestSchema.parse({
        agentId: "4a45b497-ae82-4c48-b1df-d6057c0f4cef",
        provider: "email",
        externalEventId: "event-1",
        title: "Alert",
        body: "Details",
      }),
    ).toThrow();
  });
});
