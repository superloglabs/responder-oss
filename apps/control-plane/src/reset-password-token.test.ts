import { describe, expect, it } from "vitest";
import { takeResetPasswordToken } from "./reset-password-token";

describe("takeResetPasswordToken", () => {
  it("returns the token and removes it from the address", () => {
    const replaced: string[] = [];
    const token = takeResetPasswordToken(
      "https://superlog.sh/reset-password?token=abc&utm=x",
      (url) => replaced.push(url),
    );

    expect(token).toBe("abc");
    expect(replaced).toEqual(["https://superlog.sh/reset-password?utm=x"]);
  });

  it("leaves the address alone without a token", () => {
    const replaced: string[] = [];
    const token = takeResetPasswordToken(
      "https://superlog.sh/reset-password?error=INVALID_TOKEN",
      (url) => replaced.push(url),
    );

    expect(token).toBeNull();
    expect(replaced).toEqual([]);
  });
});
