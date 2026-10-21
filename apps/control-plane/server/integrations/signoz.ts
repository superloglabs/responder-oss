import { z } from "zod";
import type { SignozInstance } from "../../../../packages/core/src/integrations/signoz.js";

const signozServiceAccountSchema = z.object({
  data: z.object({
    id: z.string().min(1).optional(),
    name: z.string().optional(),
    orgId: z.string().min(1).optional(),
  }).passthrough(),
});

export class SignozCredentialsError extends Error {
  constructor() {
    super("SigNoz rejected the API key");
  }
}

// SigNoz Cloud answers an unknown tenant host with an HTML 404 page.
export class SignozInstanceNotFoundError extends Error {
  constructor() {
    super("SigNoz has no instance at this URL. Copy it from the address bar while signed in to SigNoz.");
  }
}

// Verifies a service account API key against the instance it belongs to.
// The instance host identifies the connection.
export async function signozAccount(input: {
  apiKey: string;
  instance: SignozInstance;
}) {
  const response = await fetch(`${input.instance.instanceUrl}/api/v1/service_accounts/me`, {
    headers: {
      accept: "application/json",
      "SIGNOZ-API-KEY": input.apiKey,
    },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 401 || response.status === 403) {
    throw new SignozCredentialsError();
  }
  if (
    response.status === 404 &&
    !response.headers.get("content-type")?.includes("application/json")
  ) {
    throw new SignozInstanceNotFoundError();
  }
  if (!response.ok) throw new Error(`SigNoz returned ${response.status}`);

  const payload = signozServiceAccountSchema.parse(await response.json());
  const host = new URL(input.instance.instanceUrl).hostname;
  return {
    displayName: host,
    externalAccountId: host,
    metadata: {
      instanceUrl: input.instance.instanceUrl,
      mcpUrl: input.instance.mcpUrl,
      region: input.instance.region,
      ...(payload.data.orgId ? { signozOrganizationId: payload.data.orgId } : {}),
      ...(payload.data.name ? { serviceAccountName: payload.data.name } : {}),
    },
  };
}
