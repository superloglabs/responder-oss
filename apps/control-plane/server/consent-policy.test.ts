import { inspectPolicies } from "@c15t/backend";
import { describe, expect, it } from "vitest";
import {
  allowsMarketing,
  consentPolicyFor,
  consentPolicyPacks,
  savedConsentCategories,
  withViewerLocation,
} from "./consent-policy.js";

function viewer(country?: string, region?: string, extra?: HeadersInit) {
  const headers = new Headers(extra);
  if (country) headers.set("cloudfront-viewer-country", country);
  if (region) headers.set("cloudfront-viewer-country-region", region);
  return headers;
}

describe("consent policy packs", () => {
  it("validates without errors", () => {
    expect(inspectPolicies(consentPolicyPacks).errors).toEqual([]);
  });

  it.each([
    [undefined, undefined, "europe_opt_in"],
    ["DE", "BY", "europe_opt_in"],
    ["GB", undefined, "europe_opt_in"],
    ["CH", undefined, "europe_opt_in"],
    ["CA", "QC", "quebec_opt_in"],
    ["CA", "ON", "world_no_banner"],
    ["US", "CA", "california_opt_out"],
    ["US", "NY", "world_no_banner"],
  ])("resolves %s-%s to %s", (country, region, policyId) => {
    expect(
      consentPolicyFor({ country: country ?? null, region: region ?? null })
        ?.id,
    ).toBe(policyId);
  });
});

describe("withViewerLocation", () => {
  it("maps CloudFront viewer headers to c15t geolocation headers", () => {
    const request = withViewerLocation(
      new Request("https://example.test/api/c15t/init", {
        headers: viewer("us", "CA"),
      }),
    );

    expect(request.headers.get("x-c15t-country")).toBe("US");
    expect(request.headers.get("x-c15t-region")).toBe("CA");
  });

  it("drops geolocation headers sent by the browser", () => {
    const request = withViewerLocation(
      new Request("https://example.test/api/c15t/init", {
        headers: { "x-c15t-country": "US", "x-c15t-region": "NY" },
      }),
    );

    expect(request.headers.get("x-c15t-country")).toBeNull();
    expect(request.headers.get("x-c15t-region")).toBeNull();
  });

  it("ignores malformed viewer headers", () => {
    const request = withViewerLocation(
      new Request("https://example.test/api/c15t/init", {
        headers: viewer("US; drop"),
      }),
    );

    expect(request.headers.get("x-c15t-country")).toBeNull();
  });
});

describe("savedConsentCategories", () => {
  it("reads granted categories from the c15t cookie", () => {
    expect(
      savedConsentCategories(
        "theme=dark; c15t=c.necessary%3A1%2Cc.marketing%3A1%2Ci.t%3A1790343720817",
      ),
    ).toEqual(new Set(["necessary", "marketing"]));
  });

  it("is null before the visitor saves a choice", () => {
    expect(savedConsentCategories("theme=dark")).toBeNull();
    expect(savedConsentCategories(null)).toBeNull();
  });
});

describe("allowsMarketing", () => {
  it("follows a saved choice", () => {
    expect(
      allowsMarketing(viewer("US", "NY", { cookie: "c15t=c.necessary:1" })),
    ).toBe(false);
    expect(
      allowsMarketing(
        viewer("DE", undefined, { cookie: "c15t=c.necessary:1,c.marketing:1" }),
      ),
    ).toBe(true);
  });

  it("requires a choice where consent is opt-in", () => {
    expect(allowsMarketing(viewer("FR"))).toBe(false);
    expect(allowsMarketing(viewer())).toBe(false);
  });

  it("allows marketing by default elsewhere", () => {
    expect(allowsMarketing(viewer("US", "NY"))).toBe(true);
    expect(allowsMarketing(viewer("US", "CA"))).toBe(true);
  });

  it("honors Global Privacy Control in California", () => {
    expect(allowsMarketing(viewer("US", "CA", { "sec-gpc": "1" }))).toBe(false);
  });
});
