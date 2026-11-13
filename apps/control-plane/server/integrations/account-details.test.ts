import { describe, expect, it } from "vitest";
import { integrationAccountDetails } from "./account-details.js";

describe("integrationAccountDetails", () => {
  it("shows the Datadog site and key owner but no keys or MCP URL", () => {
    expect(integrationAccountDetails({
      provider: "datadog",
      externalAccountId: "org-1",
      metadata: {
        datacenter: "US1",
        mcpUrl: "https://mcp.datadoghq.com",
        serviceAccount: true,
        site: "datadoghq.com",
        siteName: "US1",
        userHandle: "signal@acme.com",
        userId: "user-1",
      },
    })).toEqual({ serviceAccount: true, site: "datadoghq.com", siteName: "US1", userHandle: "signal@acme.com" });
  });

  it("tells Grafana Cloud stacks from self-hosted servers", () => {
    expect(integrationAccountDetails({
      provider: "grafana",
      externalAccountId: "cloud:acme.grafana.net",
      metadata: { authType: "oauth", mcpUrl: "https://mcp", stackUrl: "https://acme.grafana.net" },
    })).toEqual({ deployment: "cloud", url: "https://acme.grafana.net" });
    expect(integrationAccountDetails({
      provider: "grafana",
      externalAccountId: "https://grafana.acme.dev:1",
      metadata: { authType: "service_account", grafanaUrl: "https://grafana.acme.dev", organizationId: 1, organizationName: "Main Org." },
    })).toEqual({ deployment: "self_hosted", organizationName: "Main Org.", url: "https://grafana.acme.dev" });
  });

  it("shows the AWS account only once AWS has reported it", () => {
    expect(integrationAccountDetails({
      provider: "aws",
      externalAccountId: "123456789012",
      metadata: { roleName: "ResponderInvestigationRole" },
    })).toEqual({ awsAccountId: "123456789012", roleName: "ResponderInvestigationRole" });
    expect(integrationAccountDetails({
      provider: "aws",
      externalAccountId: "registration:abc",
      metadata: { roleName: "ResponderInvestigationRole" },
    })).toEqual({ roleName: "ResponderInvestigationRole" });
  });

  it("names the Google Cloud service account and its roles", () => {
    expect(integrationAccountDetails({
      provider: "gcp",
      externalAccountId: "acme-prod",
      metadata: {
        permissionRoles: ["roles/logging.viewer", 3],
        projectName: "Acme Production",
        serviceAccountId: "responder-investigation",
      },
    })).toEqual({
      projectName: "Acme Production",
      roles: ["roles/logging.viewer"],
      serviceAccountEmail: "responder-investigation@acme-prod.iam.gserviceaccount.com",
    });
  });

  it("shows the Sentry organization and the PostHog and Railway access levels", () => {
    expect(integrationAccountDetails({ provider: "sentry", externalAccountId: "install-1", metadata: { organizationSlug: "acme" } }))
      .toEqual({ organizationSlug: "acme" });
    expect(integrationAccountDetails({ provider: "posthog", externalAccountId: "uuid", metadata: { accessLevel: "read_only" } }))
      .toEqual({ accessLevel: "read_only" });
    expect(integrationAccountDetails({
      provider: "railway",
      externalAccountId: "user-1:redeploy",
      metadata: { accessLevel: "redeploy", workspaces: [{ id: "w", name: "Acme" }] },
    })).toEqual({ accessLevel: "redeploy" });
  });

  it("adds nothing for providers without details", () => {
    expect(integrationAccountDetails({ provider: "linear", externalAccountId: "ws", metadata: { mcpUrl: "x" } })).toBeUndefined();
  });
});
