import { describe, expect, it, vi } from "vitest";
import { matchesSlackPhrase } from "./slack-phrase-match.js";

describe("matchesSlackPhrase", () => {
  it("matches any phrase case-insensitively anywhere in the text", () => {
    expect(matchesSlackPhrase(["^resolved:"], "Resolved: Checkout errors")).toBe(true);
    expect(matchesSlackPhrase(["nightly", "checkout errors"], "Triggered: CHECKOUT ERRORS")).toBe(true);
    expect(matchesSlackPhrase(["^resolved:"], "Triggered: not resolved: yet")).toBe(false);
    expect(matchesSlackPhrase([], "anything")).toBe(false);
  });

  it("stops a phrase that backtracks past the timeout and checks the rest", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const started = Date.now();
    expect(matchesSlackPhrase(["(a+)+$", "^a"], `${"a".repeat(40)}b`)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("slack_phrase_match_failed"));
    warn.mockRestore();
  });
});
