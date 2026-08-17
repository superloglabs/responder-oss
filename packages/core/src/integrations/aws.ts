import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  AssumeRoleCommand,
  GetCallerIdentityCommand,
  STSClient,
  type Credentials,
} from "@aws-sdk/client-sts";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { z } from "zod";

export const AWS_INVESTIGATION_ROLE_NAME = "ResponderInvestigationRole";
export const AWS_MANAGED_MCP_ENDPOINT =
  "https://aws-mcp.us-east-1.api.aws/mcp";
export const AWS_MCP_SIGNING_REGION = "us-east-1";
const AWS_COMMERCIAL_REGION_PATTERN =
  /^(?:af|ap|ca|eu|il|me|mx|sa|us)-(?!gov-|iso)[a-z]+(?:-[a-z]+)?-\d$/;

export const awsAccountIdSchema = z.string().length(12).regex(/^\d{12}$/);
export const awsConnectionCredentialsSchema = z.object({
  accountId: awsAccountIdSchema,
  externalId: z.string().min(32).max(256),
  roleArn: z.string().regex(
    /^arn:aws:iam::\d{12}:role\/ResponderInvestigationRole$/,
  ),
});

export type AwsConnectionCredentials = z.infer<
  typeof awsConnectionCredentialsSchema
>;

export class AwsIntegrationConfigurationError extends Error {}

export function awsIntegrationPrincipalArn(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const roleArn = environment.AWS_INTEGRATION_PRINCIPAL_ARN;
  if (!roleArn || !/^arn:aws:iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]+$/.test(roleArn)) {
    throw new AwsIntegrationConfigurationError(
      "AWS account connections are not configured for this deployment",
    );
  }
  return roleArn;
}

export function awsInvestigationRoleArn(accountId: string): string {
  return `arn:aws:iam::${awsAccountIdSchema.parse(accountId)}:role/${AWS_INVESTIGATION_ROLE_NAME}`;
}

export function createAwsExternalId(): string {
  return `responder_${randomBytes(32).toString("base64url")}`;
}

const cloudFormationTemplate = readFileSync(
  new URL("./aws-cloudformation.yaml", import.meta.url),
  "utf8",
);

export function awsCloudFormationTemplate(): string {
  return cloudFormationTemplate;
}

export function awsParameterizedCloudFormationTemplate(input: {
  externalId: string;
  principalArn: string;
}): string {
  const externalId = z.string().min(32).max(256).parse(input.externalId);
  const principalArn = z.string().regex(
    /^arn:aws:iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]+$/,
  ).parse(input.principalArn);
  return cloudFormationTemplate
    .replace(
      "    Description: Responder's AWS integration broker role ARN",
      `    Description: Responder's AWS integration broker role ARN\n    Default: '${principalArn}'`,
    )
    .replace(
      "    Description: Unique identifier for this Responder workspace and AWS account",
      `    Description: Unique identifier for this Responder workspace and AWS account\n    Default: '${externalId}'`,
    );
}

export async function createAwsCloudFormationTemplateUrl(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const bucket = environment.AWS_INTEGRATION_TEMPLATE_BUCKET?.trim();
  const key = environment.AWS_INTEGRATION_TEMPLATE_KEY?.trim();
  const region = environment.AWS_INTEGRATION_TEMPLATE_REGION?.trim();
  if (!bucket || !key || !region || !AWS_COMMERCIAL_REGION_PATTERN.test(region)) {
    return null;
  }

  return getSignedUrl(
    new S3Client({ region }),
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: 15 * 60 },
  );
}

function isSupportedCloudFormationTemplateUrl(templateUrl: URL): boolean {
  if (templateUrl.protocol !== "https:") return false;
  if (templateUrl.hostname === "s3.amazonaws.com") return true;
  const region = templateUrl.hostname.match(
    /^(?:[a-z0-9][a-z0-9.-]*\.)?s3[.-]([a-z0-9-]+)\.amazonaws\.com$/,
  )?.[1];
  return region !== undefined && AWS_COMMERCIAL_REGION_PATTERN.test(region);
}

export function awsCloudFormationQuickCreateUrl(input: {
  externalId: string;
  principalArn: string;
  templateUrl: string;
}): string {
  const templateUrl = new URL(input.templateUrl);
  if (!isSupportedCloudFormationTemplateUrl(templateUrl)) {
    throw new AwsIntegrationConfigurationError(
      "AWS CloudFormation quick-create templates must use an Amazon S3 URL",
    );
  }
  const parameters = new URLSearchParams({
    templateURL: templateUrl.toString(),
    stackName: "ResponderInvestigationAccess",
    param_ResponderPrincipalArn: input.principalArn,
    param_ExternalId: input.externalId,
  });
  return `https://console.aws.amazon.com/cloudformation/home#/stacks/create/review?${parameters}`;
}

interface StsTemporaryCredentials {
  accessKeyId: string;
  expiration: Date;
  secretAccessKey: string;
  sessionToken: string;
}

function temporaryCredentials(
  credentials: Credentials | undefined,
  stage: string,
): StsTemporaryCredentials {
  if (
    !credentials?.AccessKeyId ||
    !credentials.SecretAccessKey ||
    !credentials.SessionToken ||
    !credentials.Expiration
  ) {
    throw new Error(`AWS did not return credentials while assuming the ${stage} role`);
  }
  return {
    accessKeyId: credentials.AccessKeyId,
    expiration: credentials.Expiration,
    secretAccessKey: credentials.SecretAccessKey,
    sessionToken: credentials.SessionToken,
  };
}

export interface AwsTemporaryCredentials {
  accessKeyId: string;
  expiration: Date;
  secretAccessKey: string;
  sessionToken: string;
}

export async function assumeAwsInvestigationRole(
  connection: AwsConnectionCredentials,
  options: {
    environment?: NodeJS.ProcessEnv;
    sessionName?: string;
  } = {},
): Promise<AwsTemporaryCredentials> {
  const parsed = awsConnectionCredentialsSchema.parse(connection);
  const principalArn = awsIntegrationPrincipalArn(options.environment);
  const sessionSuffix = (options.sessionName ?? randomBytes(8).toString("hex"))
    .replace(/[^A-Za-z0-9+=,.@_-]/g, "-")
    .slice(0, 40);
  const brokerResult = await new STSClient({
    region: AWS_MCP_SIGNING_REGION,
  }).send(
    new AssumeRoleCommand({
      DurationSeconds: 3600,
      RoleArn: principalArn,
      RoleSessionName: `responder-broker-${sessionSuffix}`,
    }),
  );
  const broker = temporaryCredentials(brokerResult.Credentials, "broker");
  const customerResult = await new STSClient({
    credentials: {
      accessKeyId: broker.accessKeyId,
      secretAccessKey: broker.secretAccessKey,
      sessionToken: broker.sessionToken,
    },
    region: AWS_MCP_SIGNING_REGION,
  }).send(
    new AssumeRoleCommand({
      DurationSeconds: 3600,
      ExternalId: parsed.externalId,
      RoleArn: parsed.roleArn,
      RoleSessionName: `responder-investigation-${sessionSuffix}`,
    }),
  );
  const customer = temporaryCredentials(customerResult.Credentials, "investigation");
  return {
    accessKeyId: customer.accessKeyId,
    expiration: customer.expiration,
    secretAccessKey: customer.secretAccessKey,
    sessionToken: customer.sessionToken,
  };
}

export async function verifyAwsInvestigationRole(
  connection: AwsConnectionCredentials,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const parsed = awsConnectionCredentialsSchema.parse(connection);
  const credentials = await assumeAwsInvestigationRole(parsed, { environment });
  const identity = await new STSClient({
    credentials,
    region: AWS_MCP_SIGNING_REGION,
  }).send(new GetCallerIdentityCommand({}));
  if (identity.Account !== parsed.accountId) {
    throw new Error("The assumed AWS role belongs to a different account");
  }
}
