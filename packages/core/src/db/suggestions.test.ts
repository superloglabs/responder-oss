import { describe, expect, it } from "vitest";
import { suggestionEmbeddingText, suggestionFingerprint } from "./suggestions.js";

describe("suggestion search data", () => {
  it("normalizes equivalent prose for exact deduplication", () => {
    const first = {
      title: "Record queue wait time.",
      subtitle: "Queue pressure is invisible before a worker claims the job.",
      detail: "## Why\n\nThis separates queue pressure from provider latency.",
    };
    const second = {
      title: "  RECORD queue wait time. ",
      subtitle: "Queue pressure is invisible before a worker claims the job.",
      detail: "## Why  This separates queue pressure from provider latency.",
    };
    expect(suggestionFingerprint(first)).toBe(suggestionFingerprint(second));
  });

  it("embeds only the user-facing suggestion content", () => {
    expect(suggestionEmbeddingText({
      title: "Record queue wait time.",
      subtitle: "Queue pressure is invisible.",
      detail: "## Why\n\nThis helps.",
    })).toBe(
      "Record queue wait time.\nQueue pressure is invisible.\n## Why\n\nThis helps.",
    );
  });
});
