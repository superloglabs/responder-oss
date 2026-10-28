import { describe, expect, it } from "vitest";
import { conductorButton, conductorDeepLink, conductorHandoffUrl } from "./ide-handoff.js";

const sourceUrl = "https://responder.example/automations/a/runs/r?organization_id=org";
const promptOf = (url: string) => new URLSearchParams(new URL(url).hash.slice(1)).get("prompt")!;

describe("notification handoffs", () => {
  it("carries the source and exact special characters in a fragment, not a query", () => {
    const context = 'Check `mx` & "unknown"\n日本語 🚀 #1';
    const url = new URL(conductorHandoffUrl({ kind: "continue", sourceUrl, context }));
    expect(url.pathname).toBe("/api/ide/conductor");
    expect(url.search).toBe("");
    expect(promptOf(url.href)).toContain(sourceUrl);
    expect(promptOf(url.href)).toContain(context);
    expect(promptOf(url.href)).toContain("Continue the work");
    expect(promptOf(url.href)).toContain("continue on that branch");
  });

  it.each(["x", "🚀", "日本語", "\ud800"])("bounds large %s notifications without losing the source", (character) => {
    const url = conductorHandoffUrl({ kind: "fix", sourceUrl, context: character.repeat(20_000) });
    expect(url.length).toBeLessThanOrEqual(3_000);
    const prompt = promptOf(url);
    expect(prompt).toContain(sourceUrl);
    expect(prompt).toContain("Excerpt; see source");
    expect(prompt).toContain("Investigate this alert");
    expect(prompt.isWellFormed()).toBe(true);
  });

  it("creates a deep link button with the correct label for each kind", () => {
    for (const [kind, label] of [["fix", "Fix in Conductor"], ["continue", "Continue in Conductor"]] as const) {
      expect(conductorButton({ kind, sourceUrl, context: "Report" })).toMatchObject({
        type: "button", action_id: `conductor_${kind}`, text: { text: label }, url: expect.stringMatching(/^conductor:\/\/prompt=/u),
      });
    }
  });

  it.each(["Check `mx` & \"unknown\"\n日本語 🚀 #1", "🚀".repeat(20_000)])("opens Conductor directly with the bounded prompt", (context) => {
    const url = conductorDeepLink({ kind: "fix", sourceUrl, context });
    expect(url.length).toBeLessThanOrEqual(3_000);
    const prompt = decodeURIComponent(url.slice("conductor://prompt=".length));
    expect(prompt).toContain(sourceUrl);
    expect(prompt).toContain("Investigate this alert");
    expect(prompt).toContain(context.slice(0, 10));
  });

  it("rejects non-web sources", () => {
    expect(() => conductorHandoffUrl({ kind: "fix", sourceUrl: "javascript:alert(1)", context: "x" })).toThrow();
    expect(() => conductorDeepLink({ kind: "fix", sourceUrl: "javascript:alert(1)", context: "x" })).toThrow();
  });
});
