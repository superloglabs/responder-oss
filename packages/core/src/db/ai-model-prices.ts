import { and, asc, eq } from "drizzle-orm";
import type { AiPriceOverride } from "../telemetry/ai-cost.js";
import { getDatabase } from "./client.js";
import { aiModelPriceOverrides } from "./schema.js";

export type AiModelPriceOverride = AiPriceOverride & { id: string };

const columns = {
  cacheReadMtok: aiModelPriceOverrides.cacheReadMtok,
  cacheWriteMtok: aiModelPriceOverrides.cacheWriteMtok,
  id: aiModelPriceOverrides.id,
  inputMtok: aiModelPriceOverrides.inputMtok,
  model: aiModelPriceOverrides.model,
  outputMtok: aiModelPriceOverrides.outputMtok,
  provider: aiModelPriceOverrides.provider,
};

export async function listAiPriceOverrides(organizationId: string): Promise<AiModelPriceOverride[]> {
  return getDatabase()
    .select(columns)
    .from(aiModelPriceOverrides)
    .where(eq(aiModelPriceOverrides.organizationId, organizationId))
    .orderBy(asc(aiModelPriceOverrides.model), asc(aiModelPriceOverrides.provider));
}

// Sets the workspace's price for a model, replacing the one it had. Names are
// stored lowercase, as spans are matched.
export async function saveAiPriceOverride(
  organizationId: string,
  price: AiPriceOverride,
): Promise<AiModelPriceOverride> {
  const values = {
    cacheReadMtok: price.cacheReadMtok,
    cacheWriteMtok: price.cacheWriteMtok,
    inputMtok: price.inputMtok,
    model: price.model.trim().toLowerCase(),
    outputMtok: price.outputMtok,
    provider: price.provider.trim().toLowerCase(),
  };
  const [saved] = await getDatabase()
    .insert(aiModelPriceOverrides)
    .values({ ...values, organizationId })
    .onConflictDoUpdate({
      set: { ...values, updatedAt: new Date() },
      target: [aiModelPriceOverrides.organizationId, aiModelPriceOverrides.provider, aiModelPriceOverrides.model],
    })
    .returning(columns);
  return saved!;
}

export class AiPriceOverrideConflictError extends Error {
  constructor() {
    super("The workspace already has a price for this model and provider");
  }
}

// Drizzle wraps the Postgres error, so the violation is on its cause.
function isModelConflict(error: unknown): boolean {
  for (let current = error; current; current = (current as { cause?: unknown }).cause) {
    if (typeof current !== "object") break;
    if ("code" in current && current.code === "23505" && "constraint" in current && current.constraint === "ai_model_price_overrides_model_unique") {
      return true;
    }
  }
  return false;
}

// Changes one of the workspace's prices, including the model or provider it
// applies to. Null when the price does not exist.
export async function updateAiPriceOverride(
  organizationId: string,
  id: string,
  price: AiPriceOverride,
): Promise<AiModelPriceOverride | null> {
  try {
    const [updated] = await getDatabase()
      .update(aiModelPriceOverrides)
      .set({
        cacheReadMtok: price.cacheReadMtok,
        cacheWriteMtok: price.cacheWriteMtok,
        inputMtok: price.inputMtok,
        model: price.model.trim().toLowerCase(),
        outputMtok: price.outputMtok,
        provider: price.provider.trim().toLowerCase(),
        updatedAt: new Date(),
      })
      .where(and(eq(aiModelPriceOverrides.organizationId, organizationId), eq(aiModelPriceOverrides.id, id)))
      .returning(columns);
    return updated ?? null;
  } catch (error) {
    if (isModelConflict(error)) throw new AiPriceOverrideConflictError();
    throw error;
  }
}

export async function deleteAiPriceOverride(organizationId: string, id: string): Promise<boolean> {
  const deleted = await getDatabase()
    .delete(aiModelPriceOverrides)
    .where(and(eq(aiModelPriceOverrides.organizationId, organizationId), eq(aiModelPriceOverrides.id, id)))
    .returning({ id: aiModelPriceOverrides.id });
  return deleted.length > 0;
}
