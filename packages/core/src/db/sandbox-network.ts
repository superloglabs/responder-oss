import { eq } from "drizzle-orm";
import {
  defaultSandboxNetworkSettings,
  type SandboxNetworkSettings,
} from "../sandbox-network.js";
import { getDatabase } from "./client.js";
import { sandboxNetworkSettings } from "./schema.js";

export async function getSandboxNetworkSettings(
  organizationId: string,
): Promise<SandboxNetworkSettings> {
  const [row] = await getDatabase()
    .select({
      allowedDomains: sandboxNetworkSettings.allowedDomains,
      restricted: sandboxNetworkSettings.restricted,
    })
    .from(sandboxNetworkSettings)
    .where(eq(sandboxNetworkSettings.organizationId, organizationId));
  return row ?? defaultSandboxNetworkSettings;
}

export async function saveSandboxNetworkSettings(
  organizationId: string,
  settings: SandboxNetworkSettings,
  updatedBy: string | null,
): Promise<void> {
  const values = {
    allowedDomains: settings.allowedDomains,
    restricted: settings.restricted,
    updatedAt: new Date(),
    updatedBy,
  };
  await getDatabase()
    .insert(sandboxNetworkSettings)
    .values({ organizationId, ...values })
    .onConflictDoUpdate({ target: sandboxNetworkSettings.organizationId, set: values });
}
