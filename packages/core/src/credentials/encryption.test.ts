import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptCredentials, encryptCredentials } from "./encryption.js";

describe("credential encryption", () => {
  it("round trips a credential envelope without exposing plaintext", () => {
    const key = randomBytes(32).toString("base64");
    const credentials = {
      accessToken: "customer-secret",
      refreshToken: "refresh-secret",
    };

    const encrypted = encryptCredentials(credentials, key);

    expect(encrypted).not.toContain(credentials.accessToken);
    expect(decryptCredentials(encrypted, key)).toEqual(credentials);
  });

  it("rejects keys that are not 32 bytes", () => {
    expect(() => encryptCredentials({}, Buffer.from("short").toString("base64"))).toThrow(
      "32-byte key",
    );
  });
});
