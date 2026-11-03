import { describe, expect, it } from "vitest";
import {
  sandboxAllowedDomains,
  sandboxNetworkFor,
  sandboxNetworkSettingsSchema,
} from "./sandbox-network.js";

describe("sandboxNetworkSettingsSchema", () => {
  it("normalizes and deduplicates domains", () => {
    expect(sandboxNetworkSettingsSchema.parse({
      allowedDomains: [" Registry.npmjs.org ", "registry.npmjs.org", "*.example.com"],
      restricted: true,
    })).toEqual({ allowedDomains: ["registry.npmjs.org", "*.example.com"], restricted: true });
  });

  it.each(["https://example.com", "example.com/path", "example.com:443", "localhost", "*.com.*"])(
    "rejects %s",
    (domain) => {
      expect(sandboxNetworkSettingsSchema.safeParse({ allowedDomains: [domain], restricted: true }).success)
        .toBe(false);
    },
  );

  it("rejects more than 50 domains", () => {
    const allowedDomains = Array.from({ length: 51 }, (_, index) => `host${index}.example.com`);
    expect(sandboxNetworkSettingsSchema.safeParse({ allowedDomains, restricted: true }).success).toBe(false);
  });
});

describe("sandboxNetworkFor", () => {
  it("leaves an unrestricted workspace open, even with a saved list", () => {
    expect(sandboxNetworkFor({ allowedDomains: ["example.com"], restricted: false }, "https://superlog.sh"))
      .toBeNull();
  });

  it("always allows Superlog's host", () => {
    expect(sandboxNetworkFor({ allowedDomains: [], restricted: true }, "https://superlog.sh/app"))
      .toEqual({ allowedDomains: ["superlog.sh"] });
  });

  it("adds each secret's hosts once", () => {
    expect(sandboxAllowedDomains(
      { allowedDomains: ["superlog.sh", "api.example.com"] },
      [{ allowedHosts: ["api.example.com", "*.datadoghq.com"] }, {}],
    )).toEqual(["superlog.sh", "api.example.com", "*.datadoghq.com"]);
  });
});
