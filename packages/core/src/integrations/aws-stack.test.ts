import { describe, expect, it, vi } from "vitest";
import { awsStackUpdateConsoleUrl, describeAwsStack, findAwsStack, type AwsFetch } from "./aws-stack.js";

const credentials = { accessKeyId: "AKIA", expiration: new Date(), secretAccessKey: "secret", sessionToken: "token" };
const stackId = (region: string) => `arn:aws:cloudformation:${region}:123456789012:stack/ResponderInvestigationAccess/abc`;

function answer(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

function stack(region: string, keys: string[], status = "CREATE_COMPLETE") {
  return {
    DescribeStacksResponse: {
      DescribeStacksResult: {
        Stacks: [{ Parameters: keys.map((ParameterKey) => ({ ParameterKey, ParameterValue: "x" })), StackId: stackId(region), StackStatus: status }],
      },
    },
  };
}

describe("finding the Superlog stack", () => {
  it("signs a DescribeStacks call to the region and reads the stack's parameters", async () => {
    const fetch = vi.fn<AwsFetch>(async () => answer(200, stack("us-west-2", ["ResponderPrincipalArn", "ExternalId"])));
    const found = await describeAwsStack({ credentials, fetch, region: "us-west-2", stackName: "ResponderInvestigationAccess" });
    expect(found).toEqual({ parameterKeys: ["ResponderPrincipalArn", "ExternalId"], region: "us-west-2", stackId: stackId("us-west-2") });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://cloudformation.us-west-2.amazonaws.com/");
    expect(init.body).toBe("Action=DescribeStacks&StackName=ResponderInvestigationAccess&Version=2010-05-15");
    expect(init.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIA\/\d{8}\/us-west-2\/cloudformation\/aws4_request/u);
    expect(init.headers["x-amz-security-token"]).toBe("token");
  });

  it("treats a missing, deleted, or unreadable stack as not found", async () => {
    const missing = vi.fn<AwsFetch>(async () => answer(400, { Error: { Code: "ValidationError", Message: "Stack with id x does not exist" } }));
    expect(await describeAwsStack({ credentials, fetch: missing, region: "eu-west-1", stackName: "ResponderInvestigationAccess" })).toBeNull();
    const deleted = vi.fn<AwsFetch>(async () => answer(200, stack("eu-west-1", [], "DELETE_COMPLETE")));
    expect(await describeAwsStack({ credentials, fetch: deleted, region: "eu-west-1", stackName: "ResponderInvestigationAccess" })).toBeNull();
    const offline = vi.fn<AwsFetch>(async () => { throw new Error("getaddrinfo ENOTFOUND"); });
    expect(await describeAwsStack({ credentials, fetch: offline, region: "me-south-1", stackName: "ResponderInvestigationAccess" })).toBeNull();
  });

  it("prefers the first region listed when the stack is found in several", async () => {
    const fetch = vi.fn<AwsFetch>(async (url) => {
      const region = /cloudformation\.([a-z0-9-]+)\./u.exec(url)![1]!;
      return region === "eu-west-1" ? answer(400, {}) : answer(200, stack(region, ["ExternalId"]));
    });
    const found = await findAwsStack({ credentials, fetch, regions: ["eu-west-1", "eu-west-3", "us-west-2"], stackName: "ResponderInvestigationAccess" });
    expect(found?.region).toBe("eu-west-3");
  });
});

describe("the stack update link", () => {
  it("opens the stack's update page with the template chosen", () => {
    const url = new URL(awsStackUpdateConsoleUrl({ region: "us-west-2", stackId: stackId("us-west-2"), templateUrl: "https://b.s3.amazonaws.com/t.yaml?X-Amz-Signature=a&b=c" }));
    expect(url.origin).toBe("https://us-west-2.console.aws.amazon.com");
    expect(url.searchParams.get("region")).toBe("us-west-2");
    const [route, query] = url.hash.slice(1).split("?");
    expect(route).toBe("/stacks/update/template");
    const params = new URLSearchParams(query);
    expect(params.get("stackId")).toBe(stackId("us-west-2"));
    expect(params.get("templateURL")).toBe("https://b.s3.amazonaws.com/t.yaml?X-Amz-Signature=a&b=c");
  });

  it("falls back to the stacks list without a stack", () => {
    expect(awsStackUpdateConsoleUrl({ region: "eu-west-3" })).toBe("https://eu-west-3.console.aws.amazon.com/cloudformation/home?region=eu-west-3#/stacks");
  });
});
