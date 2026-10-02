import { describe, expect, it } from "vitest";
import { apiKeyUsage } from "./api-keys-api";

const createdBy = { email: "ash@example.com", id: "user", name: "Ash" };
const now = new Date("2026-10-02T12:00:00.000Z");

describe("API key usage", () => {
  it("names the member the key acts as and when it was last used", () => {
    expect(apiKeyUsage({ createdBy, lastUsedAt: null }, now)).toBe("Acts as Ash · Never used");
    expect(apiKeyUsage({ createdBy, lastUsedAt: "2026-10-02T11:59:30.000Z" }, now)).toBe("Acts as Ash · Used just now");
    expect(apiKeyUsage({ createdBy, lastUsedAt: "2026-10-02T11:15:00.000Z" }, now)).toBe("Acts as Ash · Used 45 minutes ago");
    expect(apiKeyUsage({ createdBy, lastUsedAt: "2026-10-02T11:00:00.000Z" }, now)).toBe("Acts as Ash · Used 1 hour ago");
    expect(apiKeyUsage({ createdBy, lastUsedAt: "2026-09-29T12:00:00.000Z" }, now)).toBe("Acts as Ash · Used 3 days ago");
  });

  it("falls back to the email when the member has no name", () => {
    expect(apiKeyUsage({ createdBy: { ...createdBy, name: "" }, lastUsedAt: null }, now))
      .toBe("Acts as ash@example.com · Never used");
  });
});
