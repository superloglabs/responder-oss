import { Sha256 } from "@aws-crypto/sha256-js";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import type { AwsTemporaryCredentials } from "./aws.js";

// Finds a customer's Superlog stack, so a stack update opens in the region the
// stack actually lives in. Stacks made before the cell moved regions are not
// in the registration topic's region.

export interface AwsStackLocation {
  parameterKeys: string[];
  region: string;
  stackId: string;
}

export type AwsFetch = (url: string, init: { body: string; headers: Record<string, string>; method: "POST" }) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

const describeStacksResultSchema = (value: unknown): AwsStackLocation | null => {
  const stacks = (value as {
    DescribeStacksResponse?: { DescribeStacksResult?: { Stacks?: Array<{ Parameters?: Array<{ ParameterKey?: unknown }> | null; StackId?: unknown; StackStatus?: unknown }> } };
  })?.DescribeStacksResponse?.DescribeStacksResult?.Stacks;
  const stack = stacks?.[0];
  if (!stack || typeof stack.StackId !== "string") return null;
  if (typeof stack.StackStatus === "string" && stack.StackStatus.startsWith("DELETE_")) return null;
  const region = stack.StackId.split(":")[3];
  if (!region) return null;
  return {
    parameterKeys: (stack.Parameters ?? []).flatMap((parameter) => typeof parameter.ParameterKey === "string" ? [parameter.ParameterKey] : []),
    region,
    stackId: stack.StackId,
  };
};

// Reads one stack with the connection's read-only credentials. Null when the
// region has no such stack or cannot be read, as when it is not enabled.
export async function describeAwsStack(input: {
  credentials: AwsTemporaryCredentials;
  fetch?: AwsFetch;
  region: string;
  stackName: string;
}): Promise<AwsStackLocation | null> {
  const host = `cloudformation.${input.region}.amazonaws.com`;
  const body = new URLSearchParams({ Action: "DescribeStacks", StackName: input.stackName, Version: "2010-05-15" }).toString();
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
  const signed = await signer.sign(new HttpRequest({
    body,
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", host },
    hostname: host,
    method: "POST",
    path: "/",
    protocol: "https:",
  }));
  const send: AwsFetch = input.fetch ?? ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(5_000) }));
  try {
    const response = await send(`https://${host}/`, { body, headers: signed.headers as Record<string, string>, method: "POST" });
    if (!response.ok) return null;
    return describeStacksResultSchema(JSON.parse(await response.text()));
  } catch {
    return null;
  }
}

// Looks in every given region at once and prefers the first region listed,
// which is where new stacks are created.
export async function findAwsStack(input: {
  credentials: AwsTemporaryCredentials;
  fetch?: AwsFetch;
  regions: string[];
  stackName: string;
}): Promise<AwsStackLocation | null> {
  const found = await Promise.all(input.regions.map((region) => describeAwsStack({ ...input, region })));
  return found.find((location) => location !== null) ?? null;
}

// Opens CloudFormation's "Update stack" page for the stack with the new
// template already chosen. AWS does not document this console route; if it
// stops working, change it here only. Without a stack, the stacks list in
// `region` is the fallback.
export function awsStackUpdateConsoleUrl(input: { region: string; stackId?: string | null; templateUrl?: string | null }): string {
  const base = `https://${input.region}.console.aws.amazon.com/cloudformation/home?region=${input.region}`;
  if (!input.stackId) return `${base}#/stacks`;
  const query = new URLSearchParams({ stackId: input.stackId, ...(input.templateUrl ? { templateURL: input.templateUrl } : {}) });
  return `${base}#/stacks/update/template?${query.toString()}`;
}
