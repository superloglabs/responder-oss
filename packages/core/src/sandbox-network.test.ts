import { describe, expect, it } from "vitest";
import {
  defaultSandboxNetworkSettings,
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

  it("counts a repeated domain once", () => {
    const allowedDomains = Array.from({ length: 60 }, () => "registry.npmjs.org");
    expect(sandboxNetworkSettingsSchema.parse({ allowedDomains, restricted: true }).allowedDomains)
      .toEqual(["registry.npmjs.org"]);
  });

  it("rejects more than 50 domains", () => {
    const allowedDomains = Array.from({ length: 51 }, (_, index) => `host${index}.example.com`);
    expect(sandboxNetworkSettingsSchema.safeParse({ allowedDomains, restricted: true }).success).toBe(false);
  });
});

describe("defaultSandboxNetworkSettings", () => {
  it("restricts a workspace that never saved settings to a list it could save", () => {
    expect(defaultSandboxNetworkSettings.restricted).toBe(true);
    expect(sandboxNetworkSettingsSchema.parse(defaultSandboxNetworkSettings)).toEqual(defaultSandboxNetworkSettings);
    expect(defaultSandboxNetworkSettings.allowedDomains).toEqual([
      "registry.npmjs.org",
      "registry.yarnpkg.com",
      "nodejs.org",
      "unpkg.com",
      "cdn.jsdelivr.net",
      "pypi.org",
      "files.pythonhosted.org",
      "bootstrap.pypa.io",
      "astral.sh",
      "bun.sh",
      "proxy.golang.org",
      "sum.golang.org",
      "crates.io",
      "index.crates.io",
      "static.crates.io",
      "rubygems.org",
      "repo.maven.apache.org",
      "repo1.maven.org",
      "jsr.io",
      "deb.debian.org",
      "security.debian.org",
      "github.com",
      "api.github.com",
      "codeload.github.com",
      "*.githubusercontent.com",
    ]);
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
