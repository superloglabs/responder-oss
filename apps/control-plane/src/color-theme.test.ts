import { describe, expect, it } from "vitest";
import { resolveColorTheme } from "./color-theme.js";

describe("color theme", () => {
  it("uses a saved preference before the system preference", () => {
    expect(resolveColorTheme("dark", true)).toBe("dark");
    expect(resolveColorTheme("light", false)).toBe("light");
  });

  it("falls back to the system preference", () => {
    expect(resolveColorTheme(null, true)).toBe("light");
    expect(resolveColorTheme(null, false)).toBe("dark");
    expect(resolveColorTheme("unknown", true)).toBe("light");
  });
});
