import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { isAwsCommercialRegion } from "../../integrations/aws.js";

// A CloudFormation stack in the customer's account streams one region's
// CloudWatch metrics and logs to this cell through Firehose. It needs no
// access from this side: the stack sends with its own ingest key.

const template = readFileSync(new URL("./aws-telemetry-cloudformation.yaml", import.meta.url), "utf8");

export function awsTelemetryCloudFormationTemplate(): string {
  return template;
}

// Names the stack's resources; unique per source so several stacks can run in
// one account and region.
export function createAwsTelemetryResourcePrefix(): string {
  return `superlog-${randomBytes(4).toString("hex")}`;
}

// A short-lived link to the template in this installation's template bucket,
// which CloudFormation quick-create needs. Null when no bucket is configured.
export async function createAwsTelemetryTemplateUrl(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const bucket = environment.AWS_INTEGRATION_TEMPLATE_BUCKET?.trim();
  const key = environment.AWS_TELEMETRY_TEMPLATE_KEY?.trim();
  const region = environment.AWS_INTEGRATION_TEMPLATE_REGION?.trim();
  if (!bucket || !key || !region || !isAwsCommercialRegion(region)) return null;
  return getSignedUrl(new S3Client({ region }), new GetObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn: 15 * 60,
  });
}

export function awsTelemetryStackName(resourcePrefix: string): string {
  return `SuperlogTelemetry-${resourcePrefix.replace(/^superlog-/u, "")}`;
}

export function awsTelemetryStackParameters(input: {
  ingestKey: string;
  ingestOrigin: string;
  resourcePrefix: string;
}): Record<string, string> {
  return {
    IngestKey: input.ingestKey,
    IngestUrl: input.ingestOrigin.replace(/\/+$/u, ""),
    ResourcePrefix: input.resourcePrefix,
  };
}

// Opens the stack in the chosen region with its parameters filled in.
export function awsTelemetryQuickCreateUrl(input: {
  parameters: Record<string, string>;
  region: string;
  stackName: string;
  templateUrl: string;
}): string {
  if (!isAwsCommercialRegion(input.region)) throw new Error("Choose a commercial AWS region");
  const query = new URLSearchParams({ stackName: input.stackName, templateURL: input.templateUrl });
  for (const [name, value] of Object.entries(input.parameters)) query.set(`param_${name}`, value);
  return `https://${input.region}.console.aws.amazon.com/cloudformation/home?region=${input.region}#/stacks/quickcreate?${query}`;
}

// The same stack for people who deploy with the AWS CLI.
export function awsTelemetryDeployCommand(input: {
  parameters: Record<string, string>;
  region: string;
  stackName: string;
}): string {
  return [
    "aws cloudformation deploy \\",
    `  --region ${input.region} \\`,
    `  --stack-name ${input.stackName} \\`,
    "  --template-file superlog-aws-telemetry.yaml \\",
    "  --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND \\",
    "  --parameter-overrides \\",
    ...Object.entries(input.parameters).map(
      ([name, value], index, all) => `    ${name}=${value}${index === all.length - 1 ? "" : " \\"}`,
    ),
  ].join("\n");
}
