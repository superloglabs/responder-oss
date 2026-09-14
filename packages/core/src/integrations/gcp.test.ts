import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  createGcpAuthClient,
  createGcpSessionName,
  GCP_ACCESS_SCOPES,
  gcpConnectionCredentialsSchema,
  gcpInvestigationServiceAccountEmail,
  gcpSetupScript,
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

  it("builds a keyless, read-only setup script scoped to one broker session", () => {
    const script = gcpSetupScript(connection, {
      AWS_INTEGRATION_PRINCIPAL_ARN:
        "arn:aws:iam::111122223333:role/ResponderAwsIntegrationBroker",
    });
    expect(script).toContain("--account-id=\"$RESPONDER_AWS_ACCOUNT\"");
    expect(script).toContain("attribute.responder_connection");
    expect(script).toContain(connection.sessionName);
    expect(script).toContain("roles/cloudasset.viewer");
    expect(script).toContain("roles/logging.viewer");
    expect(script).toContain("roles/monitoring.viewer");
    expect(script).toContain("roles/mcp.toolUser");
    expect(script).not.toContain("roles/editor");
    expect(script).not.toContain("roles/owner");
    expect(spawnSync("bash", ["-n"], { input: script }).status).toBe(0);
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

});
