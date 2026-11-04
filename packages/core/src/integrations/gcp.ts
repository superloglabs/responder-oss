import { randomBytes } from "node:crypto";
import {
  AwsClient,
  type AwsSecurityCredentials,
  type AwsSecurityCredentialsSupplier,
} from "google-auth-library";
import { z } from "zod";
import {
  assumeAwsIntegrationBroker,
  awsIntegrationPrincipalArn,
  awsTaskCredentials,
  type AwsTemporaryCredentials,
} from "./aws.js";

export const GCP_WORKLOAD_IDENTITY_POOL_ID = "responder";
export const GCP_WORKLOAD_IDENTITY_PROVIDER_ID = "responder-aws";
export const GCP_INVESTIGATION_SERVICE_ACCOUNT_ID = "responder-investigation";
// Google's managed remote MCP servers that serve investigation context.
export const GCP_MCP_SERVICES = {
  assets: "https://cloudasset.googleapis.com/mcp",
  logging: "https://logging.googleapis.com/mcp",
  monitoring: "https://monitoring.googleapis.com/mcp",
} as const;
export type GcpMcpService = keyof typeof GCP_MCP_SERVICES;
export const gcpMcpServices = Object.keys(GCP_MCP_SERVICES) as GcpMcpService[];
/** Investigations and automation runs use only tools Google marks read-only. */
export function isGcpReadOnlyMcpTool(tool: {
  annotations?: { readOnlyHint?: boolean };
}): boolean {
  return tool.annotations?.readOnlyHint === true;
}
export const GCP_ACCESS_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
] as const;

export const gcpProjectIdSchema = z
  .string()
  .min(6)
  .max(30)
  .regex(/^[a-z][a-z0-9-]*[a-z0-9]$/u);
export const gcpProjectNumberSchema = z.string().regex(/^[1-9]\d{0,19}$/u);
export const gcpSessionNameSchema = z
  .string()
  .min(32)
  .max(64)
  .regex(/^responder-gcp-[A-Za-z0-9_-]+$/u);

export const gcpConnectionCredentialsSchema = z.object({
  projectId: gcpProjectIdSchema,
  projectNumber: gcpProjectNumberSchema,
  sessionName: gcpSessionNameSchema,
});

export type GcpConnectionCredentials = z.infer<
  typeof gcpConnectionCredentialsSchema
>;

export function createGcpSessionName(): string {
  return `responder-gcp-${randomBytes(24).toString("base64url")}`;
}

export function gcpWorkloadIdentityAudience(
  connection: GcpConnectionCredentials,
): string {
  const parsed = gcpConnectionCredentialsSchema.parse(connection);
  return `//iam.googleapis.com/projects/${parsed.projectNumber}/locations/global/workloadIdentityPools/${GCP_WORKLOAD_IDENTITY_POOL_ID}/providers/${GCP_WORKLOAD_IDENTITY_PROVIDER_ID}`;
}

export function gcpInvestigationServiceAccountEmail(
  connection: GcpConnectionCredentials,
): string {
  const parsed = gcpConnectionCredentialsSchema.parse(connection);
  return `${GCP_INVESTIGATION_SERVICE_ACCOUNT_ID}@${parsed.projectId}.iam.gserviceaccount.com`;
}

export const GCP_REQUIRED_SERVICES = [
  "iam.googleapis.com",
  "iamcredentials.googleapis.com",
  "sts.googleapis.com",
  "cloudasset.googleapis.com",
  "logging.googleapis.com",
  "monitoring.googleapis.com",
] as const;

export const GCP_INVESTIGATION_ROLES = [
  "roles/mcp.toolUser",
  "roles/cloudasset.viewer",
  "roles/logging.viewer",
  "roles/monitoring.viewer",
  "roles/serviceusage.serviceUsageConsumer",
] as const;

export function gcpBrokerIdentity(
  environment: NodeJS.ProcessEnv = process.env,
): { accountId: string; roleName: string } {
  const match = awsIntegrationPrincipalArn(environment).match(
    /^arn:aws:iam::(\d{12}):role\/([A-Za-z0-9+=,.@_/-]+)$/u,
  );
  if (!match?.[1] || !match[2]) {
    throw new Error("The AWS integration broker ARN is invalid");
  }
  return { accountId: match[1], roleName: match[2].split("/").at(-1)! };
}

// Only the broker role may federate, and each connection may impersonate the
// service account only through its own broker session name.
export function gcpWorkloadIdentityAttributes(roleName: string): {
  attributeCondition: string;
  attributeMapping: Record<string, string>;
} {
  return {
    attributeCondition: `attribute.aws_role == '${roleName}'`,
    attributeMapping: {
      "google.subject": "assertion.arn",
      "attribute.aws_role": "assertion.arn.extract('assumed-role/{role}/')",
      "attribute.responder_connection":
        `assertion.arn.extract('assumed-role/${roleName}/{session}')`,
    },
  };
}

export function gcpConnectionPrincipalSet(
  connection: GcpConnectionCredentials,
): string {
  const parsed = gcpConnectionCredentialsSchema.parse(connection);
  return `principalSet://iam.googleapis.com/projects/${parsed.projectNumber}/locations/global/workloadIdentityPools/${GCP_WORKLOAD_IDENTITY_POOL_ID}/attribute.responder_connection/${parsed.sessionName}`;
}

class BrokerCredentialsSupplier implements AwsSecurityCredentialsSupplier {
  private credentials: AwsTemporaryCredentials | null = null;
  private refresh: Promise<AwsTemporaryCredentials> | null = null;

  constructor(
    private readonly connection: GcpConnectionCredentials,
    private readonly environment: NodeJS.ProcessEnv,
    private readonly assume: typeof assumeAwsIntegrationBroker,
    private readonly now: () => number,
  ) {}

  async getAwsRegion(): Promise<string> {
    return this.environment.AWS_REGION ?? "us-east-1";
  }

  async getAwsSecurityCredentials(): Promise<AwsSecurityCredentials> {
    if (
      this.credentials &&
      this.credentials.expiration.getTime() - 5 * 60 * 1_000 > this.now()
    ) {
      return this.toGoogleCredentials(this.credentials);
    }
    if (!this.refresh) {
      this.refresh = this.assume({
        environment: this.environment,
        sessionName: this.connection.sessionName,
      }).finally(() => {
        this.refresh = null;
      });
    }
    this.credentials = await this.refresh;
    return this.toGoogleCredentials(this.credentials);
  }

  private toGoogleCredentials(
    credentials: AwsTemporaryCredentials,
  ): AwsSecurityCredentials {
    return {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      token: credentials.sessionToken,
    };
  }
}

export function createGcpAuthClient(
  connection: GcpConnectionCredentials,
  options: {
    assume?: typeof assumeAwsIntegrationBroker;
    environment?: NodeJS.ProcessEnv;
    now?: () => number;
  } = {},
): AwsClient {
  const parsed = gcpConnectionCredentialsSchema.parse(connection);
  const environment = options.environment ?? process.env;
  return new AwsClient({
    audience: gcpWorkloadIdentityAudience(parsed),
    aws_security_credentials_supplier: new BrokerCredentialsSupplier(
      parsed,
      environment,
      options.assume ?? assumeAwsIntegrationBroker,
      options.now ?? Date.now,
    ),
    scopes: [...GCP_ACCESS_SCOPES],
    service_account_impersonation_url:
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${gcpInvestigationServiceAccountEmail(parsed)}:generateAccessToken`,
    subject_token_type: "urn:ietf:params:aws:token-type:aws4_request",
  });
}

// An operator-configured Google service account that projects grant
// Monitoring Viewer directly, instead of connecting through the setup flow.
// The worker signs in as it with its own AWS task credentials, through a
// workload identity pool in the operator's Google Cloud project.
export interface GcpSharedReaderConfig {
  audience: string;
  serviceAccount: string;
}

const sharedReaderAudienceSchema = z
  .string()
  .regex(/^\/\/iam\.googleapis\.com\/projects\/[1-9]\d{0,19}\/locations\/global\/workloadIdentityPools\/[a-z0-9-]+\/providers\/[a-z0-9-]+$/u);
const sharedReaderServiceAccountSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/u);

export function gcpSharedReaderConfig(
  environment: NodeJS.ProcessEnv = process.env,
): GcpSharedReaderConfig | null {
  const audience = environment.GCP_SHARED_READER_AUDIENCE?.trim();
  const serviceAccount = environment.GCP_SHARED_READER_SERVICE_ACCOUNT?.trim();
  if (!audience || !serviceAccount) return null;
  return {
    audience: sharedReaderAudienceSchema.parse(audience),
    serviceAccount: sharedReaderServiceAccountSchema.parse(serviceAccount),
  };
}

type TaskCredentials = () => Promise<{
  accessKeyId: string;
  expiration?: Date;
  secretAccessKey: string;
  sessionToken?: string;
}>;

class TaskCredentialsSupplier implements AwsSecurityCredentialsSupplier {
  constructor(
    private readonly credentials: TaskCredentials,
    private readonly environment: NodeJS.ProcessEnv,
  ) {}

  async getAwsRegion(): Promise<string> {
    return this.environment.AWS_REGION ?? "us-east-1";
  }

  async getAwsSecurityCredentials(): Promise<AwsSecurityCredentials> {
    const credentials = await this.credentials();
    return {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      ...(credentials.sessionToken ? { token: credentials.sessionToken } : {}),
    };
  }
}

export function createGcpSharedReaderClient(
  config: GcpSharedReaderConfig,
  options: {
    credentials?: TaskCredentials;
    environment?: NodeJS.ProcessEnv;
  } = {},
): AwsClient {
  const environment = options.environment ?? process.env;
  return new AwsClient({
    audience: config.audience,
    aws_security_credentials_supplier: new TaskCredentialsSupplier(
      options.credentials ?? awsTaskCredentials(environment),
      environment,
    ),
    scopes: [...GCP_ACCESS_SCOPES],
    service_account_impersonation_url:
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${config.serviceAccount}:generateAccessToken`,
    subject_token_type: "urn:ietf:params:aws:token-type:aws4_request",
  });
}

export async function verifyGcpProject(
  connection: GcpConnectionCredentials,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const parsed = gcpConnectionCredentialsSchema.parse(connection);
  const client = createGcpAuthClient(parsed, { environment });
  const response = await client.request({
    method: "GET",
    url: `https://cloudasset.googleapis.com/v1/projects/${parsed.projectNumber}/assets?pageSize=1`,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error("Google Cloud Asset Inventory verification failed");
  }
}
