import { describe, expect, it } from "vitest";
import { awsRegions, defaultAwsRegion, isOfferedAwsRegion } from "./aws-regions.js";
import { isAwsCommercialRegion } from "./aws.js";

describe("AWS regions", () => {
  it("offers exactly the commercial regions AWS has", () => {
    // Pinned so a typo such as us-east-9 cannot reach the pickers or the API.
    expect([...awsRegions].sort()).toEqual([
      "af-south-1", "ap-east-1", "ap-northeast-1", "ap-northeast-2", "ap-northeast-3", "ap-south-1",
      "ap-south-2", "ap-southeast-1", "ap-southeast-2", "ap-southeast-3", "ap-southeast-4", "ca-central-1",
      "ca-west-1", "eu-central-1", "eu-central-2", "eu-north-1", "eu-south-1", "eu-south-2", "eu-west-1",
      "eu-west-2", "eu-west-3", "il-central-1", "me-central-1", "me-south-1", "mx-central-1", "sa-east-1",
      "us-east-1", "us-east-2", "us-west-1", "us-west-2",
    ]);
    expect(isOfferedAwsRegion("eu-west-1")).toBe(true);
    expect(isOfferedAwsRegion("us-foobar-1")).toBe(false);
    expect(isOfferedAwsRegion("us-gov-west-1")).toBe(false);
    for (const region of awsRegions) expect(isAwsCommercialRegion(region), region).toBe(true);
  });

  it("starts on the region nearest the cell", () => {
    expect(defaultAwsRegion("eu")).toBe("eu-west-1");
    expect(defaultAwsRegion("us")).toBe("us-east-1");
    expect(defaultAwsRegion(null)).toBe("us-east-1");
    expect(defaultAwsRegion("ap")).toBe("us-east-1");
    expect(defaultAwsRegion("constructor")).toBe("us-east-1");
  });
});
