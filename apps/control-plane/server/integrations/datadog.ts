import {
  type DatadogSite,
} from "../../../../packages/core/src/integrations/datadog.js";
import { z } from "zod";

const datadogUserSchema = z.object({
  data: z.object({
    id: z.string().min(1),
    attributes: z.object({
      handle: z.string().min(1),
      name: z.string().nullable().optional(),
      service_account: z.boolean().optional(),
    }),
    relationships: z.object({
      org: z.object({ data: z.object({ id: z.string().min(1) }) }),
    }),
  }),
  included: z
    .array(
      z.object({
        id: z.string().min(1),
        type: z.string(),
        attributes: z.object({ name: z.string().min(1).optional() }),
      }),
    )
    .optional(),
});

export class DatadogCredentialsError extends Error {
  constructor() {
    super("Datadog rejected the API or application key");
  }
}

export async function datadogAccount(input: {
  apiKey: string;
  applicationKey: string;
  site: DatadogSite;
}) {
  const response = await fetch(`${input.site.apiUrl}/api/v2/current_user`, {
    headers: {
      accept: "application/json",
      "dd-api-key": input.apiKey,
      "dd-application-key": input.applicationKey,
    },
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status === 401 || response.status === 403) {
    throw new DatadogCredentialsError();
  }
  if (!response.ok) throw new Error("Unable to load the Datadog account");

  const payload = datadogUserSchema.parse(await response.json());
  const organizationId = payload.data.relationships.org.data.id;
  const organization = payload.included?.find(
    (included) =>
      included.type === "orgs" && included.id === organizationId,
  );
  return {
    externalAccountId: organizationId,
    displayName:
      organization?.attributes.name ??
      payload.data.attributes.name ??
      payload.data.attributes.handle,
    metadata: {
      datacenter: input.site.name,
      mcpUrl: input.site.mcpUrl,
      userHandle: payload.data.attributes.handle,
      userId: payload.data.id,
      serviceAccount: payload.data.attributes.service_account ?? false,
      site: input.site.id,
      siteName: input.site.name,
    },
  };
}
