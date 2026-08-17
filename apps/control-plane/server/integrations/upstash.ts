import { z } from "zod";
import {
  UPSTASH_DEVELOPER_API_URL,
  upstashBasicAuthorization,
} from "../../../../packages/core/src/integrations/upstash.js";

const upstashDatabaseListSchema = z.array(
  z.object({
    database_id: z.string().min(1),
    database_name: z.string().min(1),
  }).passthrough(),
);

export class UpstashCredentialsError extends Error {
  constructor() {
    super("Upstash rejected the account email or API key");
  }
}

export async function upstashAccount(input: {
  apiKey: string;
  email: string;
}) {
  const email = input.email.trim().toLowerCase();
  const response = await fetch(
    `${UPSTASH_DEVELOPER_API_URL}/v2/redis/databases`,
    {
      headers: {
        accept: "application/json",
        authorization: upstashBasicAuthorization({
          apiKey: input.apiKey,
          email,
        }),
      },
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (response.status === 401 || response.status === 403) {
    throw new UpstashCredentialsError();
  }
  if (!response.ok) throw new Error("Unable to load the Upstash account");

  const databases = upstashDatabaseListSchema.parse(await response.json());
  return {
    displayName: email,
    externalAccountId: email,
    metadata: {
      databaseCount: databases.length,
    },
  };
}
