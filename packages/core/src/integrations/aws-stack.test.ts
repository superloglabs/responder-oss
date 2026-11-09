import { describe, expect, it, vi } from "vitest";
import { awsStackName, awsStackUpdateConsoleUrl, findAwsStack, findAwsStackInRegion, type AwsFetch } from "./aws-stack.js";

const credentials = { accessKeyId: "AKIA", expiration: new Date(), secretAccessKey: "secret", sessionToken: "token" };
const externalId = "responder_RbX3tZstVoPQhAbXhdzc-b5BTOgaAR0CVOm-WccAW-c";
const stackId = (region: string, name = "ResponderInvestigationAccess") => `arn:aws:cloudformation:${region}:123456789012:stack/${name}/abc`;

interface Stack { externalId?: string; keys?: string[]; name?: string; region: string; status: string }

function page(stacks: Stack[], nextToken?: string) {
  return {
    DescribeStacksResponse: {
      DescribeStacksResult: {
        NextToken: nextToken ?? null,
        Stacks: stacks.map((stack) => ({
          Parameters: [
            ...(stack.keys ?? ["ResponderPrincipalArn"]).map((ParameterKey) => ({ ParameterKey, ParameterValue: "x" })),
            ...(stack.externalId ? [{ ParameterKey: "ExternalId", ParameterValue: stack.externalId }] : []),
          ],
          StackId: stackId(stack.region, stack.name),
          StackStatus: stack.status,
        })),
      },
    },
  };
}

function answer(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

// Answers DescribeStacks per region from `stacks`, two stacks per page.
function account(stacks: Stack[]): AwsFetch {
  return vi.fn<AwsFetch>(async (url, init) => {
    const region = /cloudformation\.([a-z0-9-]+)\./u.exec(url)![1]!;
    const here = stacks.filter((stack) => stack.region === region);
    const start = Number(new URLSearchParams(init.body).get("NextToken") ?? 0);
    const next = start + 2 < here.length ? String(start + 2) : undefined;
    return answer(200, page(here.slice(start, start + 2), next));
  });
}

describe("finding the connection's stack", () => {
  it("signs a DescribeStacks call for the region's stacks and asks for JSON", async () => {
    const fetch = account([{ externalId, region: "us-west-2", status: "UPDATE_COMPLETE" }]);
    const found = await findAwsStackInRegion({ credentials, externalId, fetch, region: "us-west-2" });
    expect(found).toEqual({ parameterKeys: ["ResponderPrincipalArn", "ExternalId"], region: "us-west-2", stackId: stackId("us-west-2") });
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe("https://cloudformation.us-west-2.amazonaws.com/");
    expect(init.body).toBe("Action=DescribeStacks&Version=2010-05-15");
    expect(init.headers.accept).toBe("application/json");
    expect(init.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIA\/\d{8}\/us-west-2\/cloudformation\/aws4_request/u);
    expect(init.headers["x-amz-security-token"]).toBe("token");
  });

  it("skips a dead stack in the registration region and finds the live one elsewhere", async () => {
    const fetch = account([
      // A failed earlier attempt with the same name and external ID.
      { externalId, region: "eu-west-3", status: "ROLLBACK_COMPLETE" },
      { externalId, region: "us-west-2", status: "UPDATE_COMPLETE" },
    ]);
    const found = await findAwsStack({ credentials, externalId, fetch, regions: ["eu-west-3", "us-east-1", "us-west-2"] });
    expect(found?.region).toBe("us-west-2");
    expect(found?.stackId).toBe(stackId("us-west-2"));
  });

  it("only matches the stack whose ExternalId is the connection's", async () => {
    const fetch = account([
      // Another workspace's connection to the same account.
      { externalId: "responder_someone-elses-external-id-0000000000000", region: "eu-west-3", status: "CREATE_COMPLETE" },
      { region: "eu-west-3", status: "CREATE_COMPLETE", name: "unrelated" },
    ]);
    expect(await findAwsStack({ credentials, externalId, fetch, regions: ["eu-west-3"] })).toBeNull();
  });

  it("finds a renamed stack, reads every page, and skips every state that cannot be updated", async () => {
    const dead = ["ROLLBACK_COMPLETE", "CREATE_FAILED", "UPDATE_ROLLBACK_FAILED", "DELETE_COMPLETE", "DELETE_IN_PROGRESS", "REVIEW_IN_PROGRESS"];
    const fetch = account([
      ...dead.map((status) => ({ externalId, region: "eu-west-1", status })),
      { externalId, name: "superlog-access", region: "eu-west-1", status: "UPDATE_ROLLBACK_COMPLETE" },
    ]);
    const found = await findAwsStackInRegion({ credentials, externalId, fetch, region: "eu-west-1" });
    expect(found?.stackId).toBe(stackId("eu-west-1", "superlog-access"));
    expect(vi.mocked(fetch).mock.calls).toHaveLength(4);
  });

  it("prefers the first region listed when several have a match", async () => {
    const fetch = account([
      { externalId, region: "us-west-2", status: "UPDATE_COMPLETE" },
      { externalId, region: "eu-west-3", status: "CREATE_COMPLETE" },
    ]);
    expect((await findAwsStack({ credentials, externalId, fetch, regions: ["eu-west-3", "us-west-2"] }))?.region).toBe("eu-west-3");
  });

  it("treats a region it cannot read as having no stack", async () => {
    const denied = vi.fn<AwsFetch>(async () => answer(403, { Error: { Code: "AccessDenied" } }));
    expect(await findAwsStackInRegion({ credentials, externalId, fetch: denied, region: "me-south-1" })).toBeNull();
    const offline = vi.fn<AwsFetch>(async () => { throw new Error("getaddrinfo ENOTFOUND"); });
    expect(await findAwsStackInRegion({ credentials, externalId, fetch: offline, region: "me-south-1" })).toBeNull();
  });
});

describe("a stack's name", () => {
  it("comes from its ARN", () => {
    expect(awsStackName(stackId("us-west-2", "superlog-access"))).toBe("superlog-access");
    expect(awsStackName("not-an-arn")).toBeNull();
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
