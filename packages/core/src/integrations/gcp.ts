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
  type AwsTemporaryCredentials,
} from "./aws.js";

export const GCP_WORKLOAD_IDENTITY_POOL_ID = "responder";
export const GCP_WORKLOAD_IDENTITY_PROVIDER_ID = "responder-aws";
export const GCP_INVESTIGATION_SERVICE_ACCOUNT_ID = "responder-investigation";
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

function brokerIdentity(principalArn: string): {
  accountId: string;
  roleName: string;
} {
  const match = principalArn.match(
    /^arn:aws:iam::(\d{12}):role\/([A-Za-z0-9+=,.@_/-]+)$/u,
  );
  if (!match?.[1] || !match[2]) {
    throw new Error("The AWS integration broker ARN is invalid");
  }
  return { accountId: match[1], roleName: match[2].split("/").at(-1)! };
}

export function gcpSetupScript(
  connection: GcpConnectionCredentials,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const parsed = gcpConnectionCredentialsSchema.parse(connection);
  const { accountId, roleName } = brokerIdentity(
    awsIntegrationPrincipalArn(environment),
  );
  const serviceAccountEmail = gcpInvestigationServiceAccountEmail(parsed);
  const principalSet = `principalSet://iam.googleapis.com/projects/${parsed.projectNumber}/locations/global/workloadIdentityPools/${GCP_WORKLOAD_IDENTITY_POOL_ID}/attribute.responder_connection/${parsed.sessionName}`;

  return `#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID='${parsed.projectId}'
PROJECT_NUMBER='${parsed.projectNumber}'
POOL_ID='${GCP_WORKLOAD_IDENTITY_POOL_ID}'
PROVIDER_ID='${GCP_WORKLOAD_IDENTITY_PROVIDER_ID}'
SERVICE_ACCOUNT_ID='${GCP_INVESTIGATION_SERVICE_ACCOUNT_ID}'
SERVICE_ACCOUNT_EMAIL='${serviceAccountEmail}'
RESPONDER_AWS_ACCOUNT='${accountId}'

actual_project_number="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
if [[ "$actual_project_number" != "$PROJECT_NUMBER" ]]; then
  echo "Project number does not match $PROJECT_ID" >&2
  exit 1
fi

gcloud services enable \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  cloudasset.googleapis.com \
  logging.googleapis.com \
  monitoring.googleapis.com \
  --project="$PROJECT_ID"

if ! gcloud iam service-accounts describe "$SERVICE_ACCOUNT_EMAIL" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SERVICE_ACCOUNT_ID" \
    --display-name='Responder investigations' \
    --description='Keyless read-only identity for Responder incident investigations' \
    --project="$PROJECT_ID"
fi

if ! gcloud iam workload-identity-pools describe "$POOL_ID" --location=global --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools create "$POOL_ID" \
    --location=global \
    --display-name='Responder' \
    --description='Keyless identities used by Responder investigations' \
    --project="$PROJECT_ID"
fi

attribute_mapping="google.subject=assertion.arn,attribute.aws_role=assertion.arn.extract('assumed-role/{role}/'),attribute.responder_connection=assertion.arn.extract('assumed-role/${roleName}/{session}')"
attribute_condition="attribute.aws_role == '${roleName}'"
if gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" --location=global --workload-identity-pool="$POOL_ID" --project="$PROJECT_ID" >/dev/null 2>&1; then
  existing_aws_account="$(gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" --location=global --workload-identity-pool="$POOL_ID" --project="$PROJECT_ID" --format='value(aws.accountId)')"
  if [[ "$existing_aws_account" != "$RESPONDER_AWS_ACCOUNT" ]]; then
    echo "Existing $PROVIDER_ID provider trusts a different AWS account" >&2
    exit 1
  fi
  gcloud iam workload-identity-pools providers update-aws "$PROVIDER_ID" \
    --location=global \
    --workload-identity-pool="$POOL_ID" \
    --attribute-mapping="$attribute_mapping" \
    --attribute-condition="$attribute_condition" \
    --project="$PROJECT_ID"
else
  gcloud iam workload-identity-pools providers create-aws "$PROVIDER_ID" \
    --location=global \
    --workload-identity-pool="$POOL_ID" \
    --account-id="$RESPONDER_AWS_ACCOUNT" \
    --attribute-mapping="$attribute_mapping" \
    --attribute-condition="$attribute_condition" \
    --display-name='Responder AWS broker' \
    --project="$PROJECT_ID"
fi

gcloud iam service-accounts add-iam-policy-binding "$SERVICE_ACCOUNT_EMAIL" \
  --member='${principalSet}' \
  --role='roles/iam.workloadIdentityUser' \
  --project="$PROJECT_ID"

for role in \
  roles/mcp.toolUser \
  roles/cloudasset.viewer \
  roles/logging.viewer \
  roles/monitoring.viewer \
  roles/serviceusage.serviceUsageConsumer
do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$SERVICE_ACCOUNT_EMAIL" \
    --role="$role" \
    --condition=None \
    --quiet
done

echo "Responder read-only access is ready for $PROJECT_ID."
`;
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
