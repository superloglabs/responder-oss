import { describe, expect, it, vi } from "vitest";
import { copyToClipboard } from "./copy-to-clipboard";

describe("copyToClipboard", () => {
  it("writes the complete text to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const prompt = "Investigate the alert.\n\nPreserve this formatting.";

    await copyToClipboard(prompt, { writeText });

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(prompt);
  });

  it("surfaces clipboard failures", async () => {
    const failure = new Error("Clipboard access denied");
    const writeText = vi.fn().mockRejectedValue(failure);

    await expect(copyToClipboard("Agent prompt", { writeText })).rejects.toBe(
      failure,
    );
  });
});
