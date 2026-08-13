import { describe, expect, it } from "vitest";
import { authErrorCode } from "./auth-error-code.js";

describe("authErrorCode", () => {
  it("prefers a bounded provider code", () => {
    expect(authErrorCode({ code: "INVALID_STATE", status: 400 })).toBe(
      "INVALID_STATE",
    );
  });

  it("falls back to status and a caller-provided code", () => {
    expect(authErrorCode({ status: 403 })).toBe("403");
    expect(authErrorCode(undefined, "missing_data")).toBe("missing_data");
  });
});
