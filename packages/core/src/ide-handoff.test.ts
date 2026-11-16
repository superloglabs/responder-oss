import { describe, expect, it } from "vitest";
import { conductorButton, conductorDeepLink, conductorHandoffUrl, handoffButtons, handoffDeepLink, handoffTargetsSchema } from "./ide-handoff.js";

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

  it.each([
    ["claude", "claude-cli://open?q=", "Fix in Claude Code"],
    ["codex", "codex://new?prompt=", "Fix in Codex"],
    ["t3", "t3code://new?prompt=", "Fix in T3 Code"],
    ["capy", "https://capy.ai/new?prompt=", "Fix in Capy"],
  ] as const)("opens %s with the bounded prompt", (target, prefix, label) => {
    const context = "Check `mx` & \"unknown\"\n日本語 🚀 #1";
    const url = handoffDeepLink(target, { kind: "fix", sourceUrl, context });
    expect(url.startsWith(prefix)).toBe(true);
    expect(url.length).toBeLessThanOrEqual(3_000);
    const prompt = decodeURIComponent(url.slice(prefix.length));
    expect(prompt).toContain(sourceUrl);
    expect(prompt).toContain(context);
    expect(handoffButtons({ kind: "fix", sourceUrl, context, targets: [target] })).toEqual([
      expect.objectContaining({ action_id: `${target}_fix`, text: { type: "plain_text", text: label }, url }),
    ]);
  });

  it.each(["Report 🚀", "x".repeat(20_000)])("carries the bounded prompt in the Copy prompt button's value", (context) => {
    const [button] = handoffButtons({ kind: "continue", sourceUrl, context, targets: ["prompt"] });
    expect(button).toMatchObject({ type: "button", action_id: "copy_handoff_prompt", text: { text: "Copy prompt" } });
    expect(button).not.toHaveProperty("url");
    const value = (button as { value: string }).value;
    expect(value.length).toBeLessThanOrEqual(2_000);
    expect(value).toContain(sourceUrl);
    expect(value).toContain("Continue the work");
    expect(value).toContain(context.slice(0, 10));
  });

  it("orders buttons the same way whatever order the targets come in", () => {
    const buttons = handoffButtons({ kind: "continue", sourceUrl, context: "Report", targets: ["prompt", "capy", "codex", "t3", "conductor", "claude"] });
    expect(buttons.map((button) => button.action_id)).toEqual([
      "conductor_continue", "claude_continue", "codex_continue", "t3_continue", "capy_continue", "copy_handoff_prompt",
    ]);
    expect(handoffButtons({ kind: "continue", sourceUrl, context: "Report", targets: [] })).toEqual([]);
  });

  it("accepts only known targets, without duplicates", () => {
    expect(handoffTargetsSchema.parse(["codex", "claude", "codex"])).toEqual(["claude", "codex"]);
    expect(handoffTargetsSchema.safeParse(["cursor"]).success).toBe(false);
  });

  it("rejects non-web sources", () => {
    expect(() => conductorHandoffUrl({ kind: "fix", sourceUrl: "javascript:alert(1)", context: "x" })).toThrow();
    expect(() => conductorDeepLink({ kind: "fix", sourceUrl: "javascript:alert(1)", context: "x" })).toThrow();
  });
});
