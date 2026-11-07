import type { IntegrationAccount } from "../agents-api";
import { DATADOG_SITES } from "../components/datadog-sites";

export interface ManageRow {
  label: string;
  value: string;
  // Muted text after the value, e.g. the host of a site.
  note?: string;
  code?: boolean;
  // Opens the connect form again, labelled with this text.
  action?: string;
}

export interface ManageView {
  connectedTo: string;
  rows: ManageRow[];
  disconnect: string;
}

const gcpRoleNames: Record<string, string> = {
  "roles/cloudasset.viewer": "Cloud Asset Viewer",
  "roles/logging.viewer": "Logs Viewer",
  "roles/monitoring.viewer": "Monitoring Viewer",
};

const pastFindings = "Past findings stay.";

// What a manage page shows for one connected account.
export function manageView(provider: string, name: string, account: IntegrationAccount): ManageView {
  const details = account.details ?? {};
  switch (provider) {
    case "datadog": {
      const site = DATADOG_SITES.find((candidate) => candidate.id === details.site);
      const siteName = details.siteName ?? site?.name;
      return {
        connectedTo: siteName ? `${account.displayName} on Datadog ${siteName}` : account.displayName,
        rows: [
          { label: "Organization", value: account.displayName },
          ...(siteName ? [{ label: "Site", value: siteName, note: site?.appUrl.replace("https://", "") }] : []),
          {
            label: "Keys",
            value: details.userHandle ? `Owned by ${details.userHandle}` : "Stored encrypted",
            note: details.serviceAccount ? "service account" : undefined,
            action: "Replace keys",
          },
        ],
        disconnect: `Signal deletes the stored keys and stops reading Datadog. To stop the keys working, revoke them in Datadog. ${pastFindings}`,
      };
    }
    case "grafana": {
      const cloud = details.deployment === "cloud";
      return {
        connectedTo: details.url?.replace(/^https?:\/\//u, "") ?? account.displayName,
        rows: [
          ...(details.url ? [{ label: cloud ? "Stack URL" : "Grafana URL", value: details.url }] : []),
          ...(details.organizationName ? [{ label: "Organization", value: details.organizationName }] : []),
          { label: "Deployment", value: cloud ? "Grafana Cloud" : "Self-hosted", action: cloud ? "Reconnect" : "Replace token" },
        ],
        disconnect: cloud
          ? `Signal deletes its access and stops reading Grafana. ${pastFindings}`
          : `Signal deletes the stored token and stops reading Grafana. Delete the token in Grafana to revoke it. ${pastFindings}`,
      };
    }
    case "sentry": {
      const slug = details.organizationSlug ?? account.displayName;
      return {
        connectedTo: `the ${slug} organization`,
        rows: [
          { label: "Organization", value: slug, action: "Reconnect" },
          ...(account.resourceCount > 0
            ? [{ label: "Projects", value: `${account.resourceCount} ${account.resourceCount === 1 ? "project" : "projects"}` }]
            : []),
        ],
        disconnect: `Signal stops reading Sentry. To remove its app too, uninstall it in Sentry's settings. ${pastFindings}`,
      };
    }
    case "aws":
      return {
        connectedTo: details.awsAccountId ? `AWS account ${details.awsAccountId}` : account.displayName,
        rows: [
          ...(details.awsAccountId ? [{ label: "Account", value: details.awsAccountId }] : []),
          ...(details.awsAccountId && details.roleName
            ? [{ label: "Role", value: `arn:aws:iam::${details.awsAccountId}:role/${details.roleName}`, code: true }]
            : []),
        ],
        disconnect: `Signal stops using the role. To remove the role too, delete the ResponderInvestigationAccess stack in CloudFormation. ${pastFindings}`,
      };
    case "gcp": {
      const projectId = account.projectId ?? account.displayName.replace(/^GCP · /u, "");
      return {
        connectedTo: projectId,
        rows: [
          { label: "Project", value: projectId, note: details.projectName && details.projectName !== projectId ? details.projectName : undefined },
          ...(details.serviceAccountEmail ? [{ label: "Service account", value: details.serviceAccountEmail, code: true }] : []),
          ...(details.roles?.length
            ? [{ label: "Roles", value: details.roles.map((role) => gcpRoleNames[role] ?? role).join(", ") }]
            : []),
        ],
        disconnect: details.serviceAccountEmail
          ? `Signal stops reading this project. To remove its roles too, delete ${details.serviceAccountEmail} in Google Cloud. ${pastFindings}`
          : `Signal stops reading this project. ${pastFindings}`,
      };
    }
    case "linear":
      return {
        connectedTo: `the ${account.displayName} workspace`,
        rows: [{ label: "Workspace", value: account.displayName, action: "Reconnect" }],
        disconnect: `Signal deletes its access and stops reading Linear. To remove the app too, revoke it in Linear's workspace settings. ${pastFindings}`,
      };
    case "posthog":
      return {
        connectedTo: "PostHog",
        rows: [{
          label: "Access",
          value: details.accessLevel === "read_write" ? "Read and write" : "Read only",
          action: "Reconnect",
        }],
        disconnect: `Signal deletes its access and stops reading PostHog. To remove the authorization too, revoke it in PostHog. ${pastFindings}`,
      };
    default:
      return {
        connectedTo: account.displayName,
        rows: [{ label: "Account", value: account.displayName }],
        disconnect: `Signal deletes its access and stops reading ${name}. ${pastFindings}`,
      };
  }
}

// Accounts a manage page lists. A pending account is still being connected.
export function manageableAccounts(accounts: IntegrationAccount[] | undefined) {
  return (accounts ?? []).filter((account) => account.status !== "pending");
}
