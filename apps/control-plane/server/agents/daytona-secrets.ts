import { randomUUID } from "node:crypto";
import { Daytona } from "@daytonaio/sdk";

interface DaytonaSecretConfig {
  daytonaApiKey: string;
  daytonaApiUrl?: string;
  daytonaTarget?: string;
}

function daytonaSecretConfig(
  environment: NodeJS.ProcessEnv = process.env,
): DaytonaSecretConfig {
  const daytonaApiKey = environment.DAYTONA_API_KEY;
  if (!daytonaApiKey) throw new Error("DAYTONA_API_KEY is required");
  return {
    daytonaApiKey,
    daytonaApiUrl: environment.DAYTONA_API_URL,
    daytonaTarget: environment.DAYTONA_TARGET,
  };
}

function daytonaClient(config: DaytonaSecretConfig): Daytona {
  return new Daytona({
    apiKey: config.daytonaApiKey,
    apiUrl: config.daytonaApiUrl,
    target: config.daytonaTarget,
  });
}

export async function createDaytonaWorkspaceSecret(input: {
  value: string;
  allowedHosts: string[];
}): Promise<{ id: string; name: string }> {
  const client = daytonaClient(daytonaSecretConfig());
  try {
    const secret = await client.secret.create({
      name: `responder_${randomUUID().replaceAll("-", "")}`,
      value: input.value,
      hosts: input.allowedHosts,
      description: "Responder workspace secret",
    });
    return { id: secret.id, name: secret.name };
  } finally {
    await client[Symbol.asyncDispose]().catch(() => undefined);
  }
}

export async function deleteDaytonaWorkspaceSecret(
  daytonaSecretId: string,
): Promise<void> {
  const client = daytonaClient(daytonaSecretConfig());
  try {
    await client.secret.delete(daytonaSecretId);
  } finally {
    await client[Symbol.asyncDispose]().catch(() => undefined);
  }
}
