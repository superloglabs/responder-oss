import { afterEach, describe, expect, it, vi } from "vitest";
import { trackSignupConversion } from "./signup-conversion";

const trackers = vi.hoisted(() => ({ reddit: vi.fn(), x: vi.fn() }));
vi.mock("./reddit-pixel", () => ({ trackRedditSignupPixel: trackers.reddit }));
vi.mock("./x-pixel", () => ({ trackXSignupPixel: trackers.x }));
afterEach(() => { vi.resetAllMocks(); vi.restoreAllMocks(); });

describe("signup conversion tracking", () => {
  it.each(["reddit", "x"] as const)("contains %s failures without interrupting the other tracker or signup", (failing) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    trackers[failing].mockImplementation(() => { throw new Error("blocked tracking script"); });
    expect(() => trackSignupConversion("new-user")).not.toThrow();
    expect(trackers.reddit).toHaveBeenCalledWith("new-user");
    expect(trackers.x).toHaveBeenCalledWith("new-user");
    expect(console.error).toHaveBeenCalledWith('{"event":"signup_pixel_failed"}');
  });
});
