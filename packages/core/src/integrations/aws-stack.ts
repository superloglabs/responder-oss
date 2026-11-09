import { Sha256 } from "@aws-crypto/sha256-js";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import type { AwsTemporaryCredentials } from "./aws.js";

// Finds the customer's Superlog stack, so a stack update opens the stack that
// actually holds this connection's roles. Stacks made before the cell moved
// regions are not in the registration topic's region, and a failed earlier
// attempt can leave a dead stack with the same name there.

export interface AwsStackLocation {
  parameterKeys: string[];
  region: string;
  stackId: string;
}

// The stack's name, from its ARN: arn:aws:cloudformation:<region>:<account>:stack/<name>/<id>.
export function awsStackName(stackId: string): string | null {
  return /:stack\/([^/]+)\//u.exec(stackId)?.[1] ?? null;
}

export type AwsFetch = (url: string, init: { body: string; headers: Record<string, string>; method: "POST" }) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

// The only states CloudFormation lets a stack be updated from. Others, such
// as ROLLBACK_COMPLETE after a failed create, *_FAILED, DELETE_*, or
// REVIEW_IN_PROGRESS, are refused by the console.
const updatableStatuses = new Set([
  "CREATE_COMPLETE",
  "UPDATE_COMPLETE",
  "UPDATE_ROLLBACK_COMPLETE",
  "IMPORT_COMPLETE",
  "IMPORT_ROLLBACK_COMPLETE",
]);

// How long one region's stacks are read before giving up on that region.
const regionDeadlineMs = 15_000;

interface DescribedStack {
  Parameters?: Array<{ ParameterKey?: unknown; ParameterValue?: unknown }> | null;
  StackId?: unknown;
  StackStatus?: unknown;
}

function describeStacksPage(value: unknown): { nextToken: string | null; stacks: DescribedStack[] } {
  const result = (value as {
    DescribeStacksResponse?: { DescribeStacksResult?: { NextToken?: unknown; Stacks?: DescribedStack[] | null } };
  })?.DescribeStacksResponse?.DescribeStacksResult;
  return {
    nextToken: typeof result?.NextToken === "string" && result.NextToken ? result.NextToken : null,
    stacks: Array.isArray(result?.Stacks) ? result.Stacks : [],
  };
}

// The stack in `region` that this connection made: its ExternalId parameter is
// the connection's external ID, and it can be updated. Null when the region
// has none or cannot be read, as when it is not enabled.
export async function findAwsStackInRegion(input: {
  credentials: AwsTemporaryCredentials;
  externalId: string;
  fetch?: AwsFetch;
  region: string;
}): Promise<AwsStackLocation | null> {
  const host = `cloudformation.${input.region}.amazonaws.com`;
  const signer = new SignatureV4({
    credentials: {
      accessKeyId: input.credentials.accessKeyId,
      secretAccessKey: input.credentials.secretAccessKey,
      sessionToken: input.credentials.sessionToken,
    },
    region: input.region,
    service: "cloudformation",
    sha256: Sha256,
  });
  const send: AwsFetch = input.fetch ?? ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(5_000) }));
  let nextToken: string | null = null;
  const deadline = Date.now() + regionDeadlineMs;
  try {
    // Every page, however many stacks the region has, within the deadline.
    while (Date.now() < deadline) {
      // Every stack in the region: a customer may have renamed this one.
      const body = new URLSearchParams({
        Action: "DescribeStacks",
        Version: "2010-05-15",
        ...(nextToken ? { NextToken: nextToken } : {}),
      }).toString();
      const signed = await signer.sign(new HttpRequest({
        body,
        // With this header the Query API answers JSON instead of XML.
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", host },
        hostname: host,
        method: "POST",
        path: "/",
        protocol: "https:",
      }));
      const response = await send(`https://${host}/`, { body, headers: signed.headers as Record<string, string>, method: "POST" });
      if (!response.ok) return null;
      const result = describeStacksPage(JSON.parse(await response.text()));
      for (const stack of result.stacks) {
        if (typeof stack.StackId !== "string" || typeof stack.StackStatus !== "string") continue;
        if (!updatableStatuses.has(stack.StackStatus)) continue;
        const parameters = stack.Parameters ?? [];
        if (!parameters.some((parameter) => parameter.ParameterKey === "ExternalId" && parameter.ParameterValue === input.externalId)) continue;
        return {
          parameterKeys: parameters.flatMap((parameter) => typeof parameter.ParameterKey === "string" ? [parameter.ParameterKey] : []),
          region: stack.StackId.split(":")[3] ?? input.region,
          stackId: stack.StackId,
        };
      }
      nextToken = result.nextToken;
      if (!nextToken) return null;
    }
    return null;
  } catch {
    return null;
  }
}

// Looks in every given region at once. When more than one region has a
// match, the first region listed wins.
export async function findAwsStack(input: {
  credentials: AwsTemporaryCredentials;
  externalId: string;
  fetch?: AwsFetch;
  regions: string[];
}): Promise<AwsStackLocation | null> {
  const found = await Promise.all(input.regions.map((region) => findAwsStackInRegion({ ...input, region })));
  return found.find((location) => location !== null) ?? null;
}

// Opens CloudFormation's "Update stack" page for the stack with the new
// template already chosen. AWS does not document this console route; it was
// checked on 2026-11-09, when it opened the update wizard with the template
// and reached the change set review. If it stops working, change it here
// only. Without a stack, the stacks list in `region` is the fallback.
export function awsStackUpdateConsoleUrl(input: { region: string; stackId?: string | null; templateUrl?: string | null }): string {
  const base = `https://${input.region}.console.aws.amazon.com/cloudformation/home?region=${input.region}`;
  if (!input.stackId) return `${base}#/stacks`;
  const query = new URLSearchParams({ stackId: input.stackId, ...(input.templateUrl ? { templateURL: input.templateUrl } : {}) });
  return `${base}#/stacks/update/template?${query.toString()}`;
}
