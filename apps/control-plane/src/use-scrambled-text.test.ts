import { describe, expect, it } from "vitest";
import { scrambleFrame } from "./use-scrambled-text";

describe("scrambleFrame", () => {
  const token = "sl_ingest_Qm4x9TfK2pLw";

  it("shows the revealed start and masks the rest with symbols", () => {
    const frame = scrambleFrame(token, 10);

    expect(frame).toHaveLength(token.length);
    expect(frame.slice(0, 10)).toBe("sl_ingest_");
    expect(frame.slice(10)).toMatch(/^[-_~`!@#$%^&*()+=[\]{}|;:,.<>?]+$/u);
  });

  it("keeps whitespace in place", () => {
    expect(scrambleFrame("Copy key", 0)[4]).toBe(" ");
  });

  it("changes the symbols from one step to the next", () => {
    expect(scrambleFrame(token, 3).slice(4)).not.toBe(scrambleFrame(token, 4).slice(4));
  });

  it("returns the text once every character is revealed", () => {
    expect(scrambleFrame(token, token.length)).toBe(token);
  });
});
