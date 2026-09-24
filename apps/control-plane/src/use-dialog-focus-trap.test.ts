import { describe, expect, it } from "vitest";
import { wrappedFocusIndex } from "./use-dialog-focus-trap";

describe("wrappedFocusIndex", () => {
  it("wraps from the last control to the first", () => {
    expect(wrappedFocusIndex(4, 3, false)).toBe(0);
  });

  it("wraps from the first control to the last when moving backwards", () => {
    expect(wrappedFocusIndex(4, 0, true)).toBe(3);
  });

  it("leaves moves between inner controls to the browser", () => {
    expect(wrappedFocusIndex(4, 1, false)).toBeNull();
    expect(wrappedFocusIndex(4, 2, true)).toBeNull();
  });

  it("pulls focus back in when it is outside the dialog", () => {
    expect(wrappedFocusIndex(4, -1, false)).toBe(0);
    expect(wrappedFocusIndex(4, -1, true)).toBe(3);
  });

  it("does nothing without focusable controls", () => {
    expect(wrappedFocusIndex(0, -1, false)).toBeNull();
  });
});
