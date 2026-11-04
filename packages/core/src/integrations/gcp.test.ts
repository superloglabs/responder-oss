import { describe, expect, it, vi } from "vitest";
import {
  createGcpAuthClient,
  createGcpSessionName,
  createGcpSharedReaderClient,
  GCP_ACCESS_SCOPES,
  gcpConnectionCredentialsSchema,
  gcpBrokerIdentity,
  gcpConnectionPrincipalSet,
  gcpInvestigationServiceAccountEmail,
  gcpSharedReaderConfig,
  gcpWorkloadIdentityAttributes,
  gcpWorkloadIdentityAudience,
} from "./gcp.js";

const connection = {
  projectId: "responder-production",
  projectNumber: "123456789012",
  sessionName: "responder-gcp-abcdefghijklmnopqrstuvwxyz123456",
};

describe("GCP integration", () => {
  it("validates project identifiers and creates broker session names", () => {
    expect(gcpConnectionCredentialsSchema.safeParse(connection).success).toBe(true);
    expect(gcpConnectionCredentialsSchema.safeParse({
      ...connection,
      projectId: "Responder Production",
    }).success).toBe(false);
    expect(gcpConnectionCredentialsSchema.safeParse({
      ...connection,
      projectNumber: "012345678901",
    }).success).toBe(false);
    expect(createGcpSessionName()).toMatch(/^responder-gcp-[A-Za-z0-9_-]{32}$/u);
  });

  it("derives only fixed Google identity resources", () => {
    expect(gcpInvestigationServiceAccountEmail(connection)).toBe(
      "responder-investigation@responder-production.iam.gserviceaccount.com",
    );
    expect(gcpWorkloadIdentityAudience(connection)).toBe(
      "//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/responder/providers/responder-aws",
    );
  });

  it("trusts only one broker role and one connection session", () => {
    expect(gcpBrokerIdentity({
      AWS_INTEGRATION_PRINCIPAL_ARN:
        "arn:aws:iam::111122223333:role/path/ResponderAwsIntegrationBroker",
    })).toEqual({
      accountId: "111122223333",
      roleName: "ResponderAwsIntegrationBroker",
    });
    expect(gcpWorkloadIdentityAttributes("ResponderAwsIntegrationBroker")).toEqual({
      attributeCondition: "attribute.aws_role == 'ResponderAwsIntegrationBroker'",
      attributeMapping: {
        "attribute.aws_role": "assertion.arn.extract('assumed-role/{role}/')",
        "attribute.responder_connection":
          "assertion.arn.extract('assumed-role/ResponderAwsIntegrationBroker/{session}')",
        "google.subject": "assertion.arn",
      },
    });
    expect(gcpConnectionPrincipalSet(connection)).toBe(
      `principalSet://iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/responder/attribute.responder_connection/${connection.sessionName}`,
    );
  });

  it("supplies freshly assumed broker credentials to Google auth", async () => {
    const assume = vi.fn().mockResolvedValue({
      accessKeyId: "AKIAEXAMPLE",
      expiration: new Date(Date.now() + 60 * 60 * 1_000),
      secretAccessKey: "secret",
      sessionToken: "token",
    });
    const client = createGcpAuthClient(connection, {
      assume,
      environment: { AWS_REGION: "eu-west-3" },
    });
    const supplier = (client as unknown as {
      awsSecurityCredentialsSupplier: {
        getAwsRegion(context: object): Promise<string>;
        getAwsSecurityCredentials(context: object): Promise<unknown>;
      };
    }).awsSecurityCredentialsSupplier;

    expect((client as unknown as { scopes: string[] }).scopes).toEqual([
      ...GCP_ACCESS_SCOPES,
    ]);
    expect(await supplier.getAwsRegion({})).toBe("eu-west-3");
    await supplier.getAwsSecurityCredentials({});
    await supplier.getAwsSecurityCredentials({});
    expect(assume).toHaveBeenCalledTimes(1);
    expect(assume).toHaveBeenCalledWith({
      environment: { AWS_REGION: "eu-west-3" },
      sessionName: connection.sessionName,
    });
  });


  it("reads the shared reader from the environment only when it is complete", () => {
    const audience = "//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/runtime/providers/aws-runtime";
    const serviceAccount = "metrics-reader@operator-project.iam.gserviceaccount.com";

    expect(gcpSharedReaderConfig({})).toBeNull();
    expect(gcpSharedReaderConfig({ GCP_SHARED_READER_AUDIENCE: audience })).toBeNull();
    expect(gcpSharedReaderConfig({
      GCP_SHARED_READER_AUDIENCE: audience,
      GCP_SHARED_READER_SERVICE_ACCOUNT: serviceAccount,
    })).toEqual({ audience, serviceAccount });
    expect(() => gcpSharedReaderConfig({
      GCP_SHARED_READER_AUDIENCE: "https://example.com",
      GCP_SHARED_READER_SERVICE_ACCOUNT: serviceAccount,
    })).toThrow();
    expect(() => gcpSharedReaderConfig({
      GCP_SHARED_READER_AUDIENCE: audience,
      GCP_SHARED_READER_SERVICE_ACCOUNT: "not-an-account",
    })).toThrow();
    for (const invalid of [
      "//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/-/providers/aws-provider",
      "//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/runtime/providers/a",
      "//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/1runtime/providers/aws-provider",
      "//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/runtime-/providers/aws-provider",
    ]) {
      expect(() => gcpSharedReaderConfig({
        GCP_SHARED_READER_AUDIENCE: invalid,
        GCP_SHARED_READER_SERVICE_ACCOUNT: serviceAccount,
      })).toThrow();
    }
  });

  it("signs in as the shared reader with the task's own AWS credentials", async () => {
    const config = {
      audience: "//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/runtime/providers/aws-runtime",
      serviceAccount: "metrics-reader@operator-project.iam.gserviceaccount.com",
    };
    const credentials = vi.fn(async () => ({
      accessKeyId: "task-key",
      expiration: new Date("2026-10-15T11:00:00Z"),
      secretAccessKey: "task-secret",
      sessionToken: "task-token",
    }));
    const client = createGcpSharedReaderClient(config, {
      credentials,
      environment: { AWS_REGION: "us-west-2" },
    });
    const internals = client as unknown as {
      audience: string;
      awsSecurityCredentialsSupplier: {
        getAwsRegion(context: object): Promise<string>;
        getAwsSecurityCredentials(context: object): Promise<unknown>;
      };
      serviceAccountImpersonationUrl: string;
    };

    expect(internals.audience).toBe(config.audience);
    expect(internals.serviceAccountImpersonationUrl).toBe(
      "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/metrics-reader@operator-project.iam.gserviceaccount.com:generateAccessToken",
    );
    expect(await internals.awsSecurityCredentialsSupplier.getAwsRegion({})).toBe("us-west-2");
    expect(await internals.awsSecurityCredentialsSupplier.getAwsSecurityCredentials({})).toEqual({
      accessKeyId: "task-key",
      secretAccessKey: "task-secret",
      token: "task-token",
    });
  });
});
