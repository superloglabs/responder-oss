import { z } from "zod";
import { encryptCredentials } from "../../../../packages/core/src/credentials/encryption.js";
import {
  createWorkspaceSecretRecord,
  findWorkspaceSecretByName,
  storeWorkspaceSecretValue,
  type WorkspaceSecretSummary,
} from "../../../../packages/core/src/db/workspace-secrets.js";
import { workspaceSecretEnvironmentVariableNameReservation } from "../../../../packages/core/src/workspace-secret-names.js";
import {
  createDaytonaWorkspaceSecret,
  deleteDaytonaWorkspaceSecret,
} from "./daytona-secrets.js";

const secretHostSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(253)
  .regex(
    /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/,
    "Use a hostname without a scheme, path, or port",
  );

export const workspaceSecretInputSchema = z.object({
  name: z
    .string()
    .trim()
    .toUpperCase()
    .min(1, "Environment variable name is required")
    .max(80)
    .regex(
      /^[A-Z_][A-Z0-9_]*$/,
      "Use an uppercase environment variable name",
    )
    .superRefine((name, context) => {
      const reservation = workspaceSecretEnvironmentVariableNameReservation(name);
      if (reservation) {
        context.addIssue({ code: "custom", message: reservation });
      }
    }),
  value: z.string().min(1, "Secret value is required").max(65_536),
  allowedHosts: z
    .array(secretHostSchema)
    .min(1, "Add at least one allowed host")
    .max(20)
    .transform((hosts) => [...new Set(hosts)]),
});

export type WorkspaceSecretInput = z.output<typeof workspaceSecretInputSchema>;

function isWorkspaceSecretNameConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505" &&
    "constraint" in error &&
    error.constraint === "workspace_secrets_organization_name_idx"
  );
}

// Stores the value encrypted, and in Daytona when it is configured, so either
// sandbox provider can use the secret. The Daytona secret is removed again if
// the record cannot be saved. Saving a secret that has no stored value fills
// it in, because Daytona cannot return the one it holds.
export async function storeWorkspaceSecret(input: {
  organizationId: string;
  secret: WorkspaceSecretInput;
  userId: string;
}): Promise<
  | { ok: true; secret: WorkspaceSecretSummary }
  | { ok: false; error: string; status: 409 | 502 }
> {
  const { name, allowedHosts, value } = input.secret;
  const conflict = {
    error: `${name} already exists in this workspace`,
    ok: false,
    status: 409,
  } as const;
  const existing = await findWorkspaceSecretByName({
    organizationId: input.organizationId,
    name,
  });
  if (existing?.hasValue) return conflict;
  const encryptedValue = encryptCredentials({ value });
  if (existing) {
    try {
      await storeWorkspaceSecretValue({ id: existing.id, encryptedValue });
    } catch {
      return { error: "Unable to store workspace secret", ok: false, status: 502 };
    }
    return {
      ok: true,
      secret: {
        allowedHosts: existing.allowedHosts,
        createdAt: existing.createdAt,
        id: existing.id,
        name: existing.name,
      },
    };
  }

  let daytonaSecret: { id: string; name: string } | null = null;
  try {
    if (process.env.DAYTONA_API_KEY) {
      daytonaSecret = await createDaytonaWorkspaceSecret({ value, allowedHosts });
    }
    const secret = await createWorkspaceSecretRecord({
      organizationId: input.organizationId,
      userId: input.userId,
      name,
      allowedHosts,
      daytonaSecretId: daytonaSecret?.id ?? null,
      daytonaSecretName: daytonaSecret?.name ?? null,
      encryptedValue,
    });
    return { ok: true, secret };
  } catch (error) {
    if (daytonaSecret) {
      try {
        await deleteDaytonaWorkspaceSecret(daytonaSecret.id);
      } catch (cleanupError) {
        console.error("Unable to clean up workspace secret", {
          cleanupError,
          daytonaSecretId: daytonaSecret.id,
        });
        return {
          error: "Unable to clean up workspace secret after storage failed",
          ok: false,
          status: 502,
        };
      }
    }
    if (isWorkspaceSecretNameConflict(error)) return conflict;
    return { error: "Unable to store workspace secret", ok: false, status: 502 };
  }
}
