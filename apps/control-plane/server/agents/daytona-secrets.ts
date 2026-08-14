import { randomUUID } from "node:crypto";
import { Daytona } from "@daytona/sdk";
import {
  daytonaClientOptions,
  isDaytonaNotFound,
  requireDaytonaClientConfig,
  type DaytonaClientConfig,
} from "@responder/core/daytona-config";

function daytonaClient(config: DaytonaClientConfig): Daytona {
  return new Daytona(daytonaClientOptions(config));
}

export async function createDaytonaWorkspaceSecret(input: {
  value: string;
  allowedHosts: string[];
}): Promise<{ id: string; name: string }> {
  const client = daytonaClient(requireDaytonaClientConfig());
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
  const client = daytonaClient(requireDaytonaClientConfig());
  try {
    let lastError: unknown;
    for (const delayMs of [0, 250, 1_000]) {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      try {
        await client.secret.delete(daytonaSecretId);
        return;
      } catch (error) {
        if (isDaytonaNotFound(error)) {
          return;
        }
        lastError = error;
      }
    }
    throw lastError;
  } finally {
    await client[Symbol.asyncDispose]().catch(() => undefined);
  }
}
