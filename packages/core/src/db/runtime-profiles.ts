import { eq } from "drizzle-orm";
import { getDatabase } from "./client.js";
import { runtimeProfiles } from "./schema.js";

export interface RuntimeProfile {
  id: string;
  version: number;
  systemPrompt: string;
  model: string;
  modelOptions: Record<string, unknown>;
  createdBy: string;
  createdAt: Date;
}

export async function getRuntimeProfile(
  profileId: string,
): Promise<RuntimeProfile | null> {
  const db = getDatabase();
  const rows = await db
    .select({
      id: runtimeProfiles.id,
      version: runtimeProfiles.version,
      systemPrompt: runtimeProfiles.systemPrompt,
      model: runtimeProfiles.model,
      modelOptions: runtimeProfiles.modelOptions,
      createdBy: runtimeProfiles.createdBy,
      createdAt: runtimeProfiles.createdAt,
    })
    .from(runtimeProfiles)
    .where(eq(runtimeProfiles.id, profileId))
    .limit(1);
  return rows[0] ?? null;
}
