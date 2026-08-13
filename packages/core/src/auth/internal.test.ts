import { describe, expect, it } from "vitest";
import { verifyBearerToken } from "./internal.js";

describe("verifyBearerToken", () => {
  it("accepts an exact bearer token", () => {
    expect(verifyBearerToken("Bearer secret-token", "secret-token")).toBe(true);
  });

  it("rejects missing, malformed, and different tokens", () => {
    expect(verifyBearerToken(null, "secret-token")).toBe(false);
    expect(verifyBearerToken("Basic secret-token", "secret-token")).toBe(false);
    expect(verifyBearerToken("Bearer wrong", "secret-token")).toBe(false);
  });
});
