import { describe, expect, it } from "vitest";
import type { IntegrationAccount } from "../agents-api";
import { manageableAccounts, manageView } from "./manage-model";

function account(input: Partial<IntegrationAccount>): IntegrationAccount {
  return { id: "account-1", displayName: "Acme", status: "connected", resourceCount: 0, updatedAt: "2026-11-07T10:00:00Z", ...input };
}

describe("Signal manage pages", () => {
  it("shows the Datadog site and who owns the keys, with a way to replace them", () => {
    const view = manageView("datadog", "Datadog", account({
      details: { site: "datadoghq.eu", siteName: "EU", userHandle: "signal@acme.com", serviceAccount: true },
    }));
    expect(view.connectedTo).toBe("Acme on Datadog EU");
    expect(view.rows).toEqual([
      { label: "Organization", value: "Acme" },
      { label: "Site", value: "EU", note: "app.datadoghq.eu" },
      { label: "Keys", value: "Owned by signal@acme.com", note: "service account", action: "Replace keys" },
    ]);
  });

  it("offers a new token for self-hosted Grafana and a new sign-in for Grafana Cloud", () => {
    const cloud = manageView("grafana", "Grafana", account({ details: { deployment: "cloud", url: "https://acme.grafana.net" } }));
    expect(cloud.connectedTo).toBe("acme.grafana.net");
    expect(cloud.rows.at(-1)).toEqual({ label: "Deployment", value: "Grafana Cloud", action: "Reconnect" });
    const selfHosted = manageView("grafana", "Grafana", account({
      details: { deployment: "self_hosted", url: "https://grafana.acme.dev", organizationName: "Main Org." },
    }));
    expect(selfHosted.rows.map((row) => row.label)).toEqual(["Grafana URL", "Organization", "Deployment"]);
    expect(selfHosted.rows.at(-1)?.action).toBe("Replace token");
  });

  it("builds the AWS role ARN only once the account is known", () => {
    expect(manageView("aws", "AWS", account({
      displayName: "AWS · 123456789012",
      details: { awsAccountId: "123456789012", roleName: "ResponderInvestigationRole" },
    })).rows).toEqual([
      { label: "Account", value: "123456789012" },
      { label: "Role", value: "arn:aws:iam::123456789012:role/ResponderInvestigationRole", code: true },
    ]);
    expect(manageView("aws", "AWS", account({ details: { roleName: "ResponderInvestigationRole" } })).rows).toEqual([]);
  });

  it("names Google Cloud roles the way the console does", () => {
    const view = manageView("gcp", "Google Cloud", account({
      displayName: "GCP · acme-prod",
      projectId: "acme-prod",
      details: {
        projectName: "Acme Production",
        serviceAccountEmail: "responder-investigation@acme-prod.iam.gserviceaccount.com",
        roles: ["roles/logging.viewer", "roles/monitoring.viewer", "roles/custom.role"],
      },
    }));
    expect(view.connectedTo).toBe("acme-prod");
    expect(view.rows.find((row) => row.label === "Roles")?.value).toBe("Logs Viewer, Monitoring Viewer, roles/custom.role");
    expect(view.disconnect).toContain("delete responder-investigation@acme-prod.iam.gserviceaccount.com");
  });

  it("counts Sentry projects and says disconnecting leaves the Sentry app installed", () => {
    const view = manageView("sentry", "Sentry", account({ displayName: "acme", resourceCount: 12, details: { organizationSlug: "acme" } }));
    expect(view.connectedTo).toBe("the acme organization");
    expect(view.rows[1]).toEqual({ label: "Projects", value: "12 projects" });
    expect(view.disconnect).toContain("uninstall it in Sentry");
  });

  it("leaves accounts that are still connecting off the page", () => {
    expect(manageableAccounts([
      account({ id: "a", status: "connected" }),
      account({ id: "b", status: "pending" }),
      account({ id: "c", status: "error" }),
    ]).map((candidate) => candidate.id)).toEqual(["a", "c"]);
  });
});
