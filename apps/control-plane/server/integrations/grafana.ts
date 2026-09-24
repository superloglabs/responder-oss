import { z } from "zod";
import { safeCustomMcpFetch } from "@responder/core/integrations/custom-mcp";
import { normalizeGrafanaUrl } from "@responder/core/integrations/grafana";

const grafanaOrganizationSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().trim().min(1),
});

export class GrafanaCredentialsError extends Error {
  constructor() {
    super("Grafana rejected the service account token");
  }
}

export async function grafanaServiceAccountOrganization(
  input: {
    grafanaUrl: string;
    serviceAccountToken: string;
  },
  fetchImpl: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response> = safeCustomMcpFetch,
) {
  const grafanaUrl = normalizeGrafanaUrl(input.grafanaUrl);
  const response = await fetchImpl(`${grafanaUrl}/api/org`, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${input.serviceAccountToken}`,
    },
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 401 || response.status === 403) {
    console.error(
      JSON.stringify({
        event: "grafana_credentials_rejected",
        grafanaUrl,
        status: response.status,
      }),
    );
    throw new GrafanaCredentialsError();
  }
  if (!response.ok) {
    console.error(
      JSON.stringify({
        event: "grafana_organization_lookup_failed",
        grafanaUrl,
        status: response.status,
      }),
    );
    throw new Error("Unable to load the Grafana organization");
  }

  const organization = grafanaOrganizationSchema.parse(await response.json());
  const host = new URL(grafanaUrl).host;
  return {
    displayName: `${host} · ${organization.name}`,
    externalAccountId: `${grafanaUrl}:${organization.id}`,
    grafanaUrl,
    metadata: {
      authType: "service_account",
      grafanaUrl,
      organizationId: organization.id,
      organizationName: organization.name,
    },
  };
}
