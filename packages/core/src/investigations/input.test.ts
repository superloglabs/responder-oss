import { describe, expect, it } from "vitest";
import { investigationPrompt, investigationRequestSchema } from "./input.js";

describe("investigation input", () => {
  it("normalizes a provider event into a bounded investigation", () => {
    const parsed = investigationRequestSchema.parse({
      agentId: "06060606-0606-4606-8606-060606060606",
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
        agentId: "06060606-0606-4606-8606-060606060606",
        provider: "email",
        externalEventId: "event-1",
        title: "Alert",
        body: "Details",
      }),
    ).toThrow();
  });
});
