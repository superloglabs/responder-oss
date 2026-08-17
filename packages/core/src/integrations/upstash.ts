import { z } from "zod";

export const UPSTASH_DEVELOPER_API_URL = "https://api.upstash.com";

export const upstashCredentialsSchema = z.object({
  apiKey: z.string().min(1),
  authType: z.literal("api_key"),
  email: z.string().email(),
});

export type UpstashCredentials = z.infer<typeof upstashCredentialsSchema>;

export function parseUpstashCredentials(
  value: Record<string, unknown>,
): UpstashCredentials {
  return upstashCredentialsSchema.parse(value);
}

export function upstashBasicAuthorization(credentials: {
  apiKey: string;
  email: string;
}): string {
  return `Basic ${Buffer.from(
    `${credentials.email}:${credentials.apiKey}`,
    "utf8",
  ).toString("base64")}`;
}
