// AWS regions offered for the CloudFormation stacks that stream CloudWatch,
// most used first. Shared by the server's checks and the region pickers, so
// this file has no Node or SDK imports.
export const awsRegions = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-central-1",
  "eu-central-2",
  "eu-north-1",
  "eu-south-1",
  "eu-south-2",
  "ap-south-1",
  "ap-south-2",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-southeast-3",
  "ap-southeast-4",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-northeast-3",
  "ap-east-1",
  "ca-central-1",
  "ca-west-1",
  "sa-east-1",
  "me-south-1",
  "me-central-1",
  "il-central-1",
  "af-south-1",
  "mx-central-1",
] as const;

export type AwsRegion = (typeof awsRegions)[number];

export function isOfferedAwsRegion(value: string): value is AwsRegion {
  return (awsRegions as readonly string[]).includes(value);
}

// The region a picker starts on: the one nearest the workspace's cell. The
// cells are eu and us; an unknown cell, or none yet, starts on us-east-1.
const cellRegions: Record<string, AwsRegion> = { eu: "eu-west-1", us: "us-east-1" };

export function defaultAwsRegion(cellId: string | null | undefined): AwsRegion {
  return (cellId ? cellRegions[cellId] : undefined) ?? "us-east-1";
}
