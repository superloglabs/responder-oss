import { describe, expect, it } from "vitest";
import { awsRegions, defaultAwsRegion, isOfferedAwsRegion } from "./aws-regions.js";
import { isAwsCommercialRegion } from "./aws.js";

describe("AWS regions", () => {
  it("offers only real commercial regions", () => {
    expect(isOfferedAwsRegion("eu-west-1")).toBe(true);
    expect(isOfferedAwsRegion("us-foobar-1")).toBe(false);
    expect(isOfferedAwsRegion("us-gov-west-1")).toBe(false);
    for (const region of awsRegions) expect(isAwsCommercialRegion(region), region).toBe(true);
  });

  it("starts on the region nearest the cell", () => {
    expect(defaultAwsRegion("eu")).toBe("eu-west-1");
    expect(defaultAwsRegion("us")).toBe("us-east-1");
    expect(defaultAwsRegion(null)).toBe("us-east-1");
  });
});
