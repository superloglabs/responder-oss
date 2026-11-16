import { eq } from "drizzle-orm";
import { defaultHandoffTargets, handoffTargets, type HandoffTarget } from "../ide-handoff.js";
import { getDatabase } from "./client.js";
import { handoffSettings } from "./schema.js";

// The coding agents whose buttons the workspace's notifications show.
export async function getHandoffTargets(organizationId: string): Promise<HandoffTarget[]> {
  const [row] = await getDatabase()
    .select({ targets: handoffSettings.targets })
    .from(handoffSettings)
    .where(eq(handoffSettings.organizationId, organizationId))
    .limit(1);
  // Ignores targets that a later version no longer offers.
  return row ? handoffTargets.filter((target) => row.targets.includes(target)) : defaultHandoffTargets;
}

export async function saveHandoffTargets(organizationId: string, targets: HandoffTarget[]): Promise<void> {
  const updatedAt = new Date();
  await getDatabase()
    .insert(handoffSettings)
    .values({ organizationId, targets, updatedAt })
    .onConflictDoUpdate({ target: handoffSettings.organizationId, set: { targets, updatedAt } });
}
