// Facts about a connected account that people can see and check, taken from
// the metadata saved when it connected. Never includes credentials.
export interface IntegrationAccountDetails {
  site?: string;
  siteName?: string;
  userHandle?: string;
  serviceAccount?: boolean;
  deployment?: "cloud" | "self_hosted";
  url?: string;
  organizationName?: string;
  organizationSlug?: string;
  awsAccountId?: string;
  roleName?: string;
  projectName?: string;
  serviceAccountEmail?: string;
  roles?: string[];
  accessLevel?: string;
}

const text = (value: unknown) => typeof value === "string" && value.trim() ? value : undefined;

function withoutEmpty(details: IntegrationAccountDetails): IntegrationAccountDetails {
  return Object.fromEntries(
    Object.entries(details).filter(([, value]) => value !== undefined),
  ) as IntegrationAccountDetails;
}

export function integrationAccountDetails(account: {
  provider: string;
  externalAccountId: string;
  metadata: Record<string, unknown>;
}): IntegrationAccountDetails | undefined {
  const { metadata } = account;
  switch (account.provider) {
    case "datadog":
      return withoutEmpty({
        site: text(metadata.site),
        siteName: text(metadata.siteName),
        userHandle: text(metadata.userHandle),
        serviceAccount: typeof metadata.serviceAccount === "boolean" ? metadata.serviceAccount : undefined,
      });
    case "grafana": {
      const cloud = metadata.authType === "oauth";
      return withoutEmpty({
        deployment: cloud ? "cloud" : "self_hosted",
        url: text(cloud ? metadata.stackUrl : metadata.grafanaUrl),
        organizationName: cloud ? undefined : text(metadata.organizationName),
      });
    }
    case "sentry":
      return withoutEmpty({ organizationSlug: text(metadata.organizationSlug) });
    case "aws":
      return withoutEmpty({
        // A one-click setup holds a placeholder ID until AWS reports the account.
        awsAccountId: /^\d{12}$/u.test(account.externalAccountId) ? account.externalAccountId : undefined,
        roleName: text(metadata.roleName),
      });
    case "gcp": {
      const serviceAccountId = text(metadata.serviceAccountId);
      const roles = Array.isArray(metadata.permissionRoles)
        ? metadata.permissionRoles.filter((role): role is string => typeof role === "string")
        : [];
      return withoutEmpty({
        projectName: text(metadata.projectName),
        serviceAccountEmail: serviceAccountId
          ? `${serviceAccountId}@${account.externalAccountId}.iam.gserviceaccount.com`
          : undefined,
        roles: roles.length > 0 ? roles : undefined,
      });
    }
    case "posthog":
    case "railway":
      return withoutEmpty({ accessLevel: text(metadata.accessLevel) });
    default:
      return undefined;
  }
}
