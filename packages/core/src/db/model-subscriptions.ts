import { and, eq } from "drizzle-orm";
import { encryptCredentials, decryptCredentials } from "../credentials/encryption.js";
import { parseSubscriptionAuth, type ManagedSubscriptionLogin, type SubscriptionLoginTransport } from "../automations/chatgpt-subscription.js";
import { getDatabase } from "./client.js";
import { modelSubscriptionConnections, organizationModelCredentials } from "./schema.js";

type Owner = { organizationId: string; userId: string };
export async function startModelSubscription(owner: Owner, transport: SubscriptionLoginTransport) {
  const state = await transport.start();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 15 * 60_000);
  try {
  const [row] = await getDatabase().insert(modelSubscriptionConnections).values({ ...owner, encryptedState: encryptCredentials(state), expiresAt, nextPollAt: new Date(now.getTime() + 5_000) }).onConflictDoUpdate({ target: [modelSubscriptionConnections.organizationId, modelSubscriptionConnections.userId], set: { id: crypto.randomUUID(), encryptedState: encryptCredentials(state), expiresAt, credentialId: null, nextPollAt: new Date(now.getTime() + 5_000) } }).returning({ id: modelSubscriptionConnections.id });
  return { connectionId: row.id, userCode: state.userCode, verificationUrl: state.verificationUrl, interval: 5, expiresAt: expiresAt.toISOString() };
  } catch (error) { await transport.cancel(state.sandboxId).catch(() => {}); throw error; }
}
export async function pollModelSubscription(owner: Owner & { connectionId: string }, transport: SubscriptionLoginTransport) {
  return getDatabase().transaction(async (tx) => {
    const [row] = await tx.select().from(modelSubscriptionConnections).where(and(eq(modelSubscriptionConnections.id, owner.connectionId), eq(modelSubscriptionConnections.organizationId, owner.organizationId), eq(modelSubscriptionConnections.userId, owner.userId))).for("update");
    if (!row || row.expiresAt.getTime() <= Date.now()) return { status: "expired" as const };
    if (row.credentialId) return { status: "connected" as const, credentialId: row.credentialId };
    if (row.nextPollAt.getTime() > Date.now()) return { status: "pending" as const };
    const state = decryptCredentials<ManagedSubscriptionLogin>(row.encryptedState);
    const result = await transport.poll(state.sandboxId);
    if (result.status === "pending") {
      await tx.update(modelSubscriptionConnections).set({ nextPollAt: new Date(Date.now() + 5_000) }).where(eq(modelSubscriptionConnections.id, row.id));
      return { status: "pending" as const };
    }
    parseSubscriptionAuth(result.authJson);
    const [credential] = await tx.insert(organizationModelCredentials).values({ organizationId: owner.organizationId, provider: "openai", authType: "chatgpt_subscription", label: `ChatGPT subscription ${row.id.slice(0, 8)}`, encryptedCredentials: encryptCredentials({ authJson: result.authJson }), lastFour: "", status: "active" }).returning({ id: organizationModelCredentials.id });
    await tx.update(modelSubscriptionConnections).set({ credentialId: credential.id }).where(eq(modelSubscriptionConnections.id, row.id));
    return { status: "connected" as const, credentialId: credential.id };
  });
}
export async function cancelModelSubscription(owner: Owner & { connectionId: string }, transport: SubscriptionLoginTransport) {
  const rows = await getDatabase().delete(modelSubscriptionConnections).where(and(eq(modelSubscriptionConnections.id, owner.connectionId), eq(modelSubscriptionConnections.organizationId, owner.organizationId), eq(modelSubscriptionConnections.userId, owner.userId))).returning({ encryptedState: modelSubscriptionConnections.encryptedState });
  for (const row of rows) if (row.encryptedState) await transport.cancel(decryptCredentials<ManagedSubscriptionLogin>(row.encryptedState).sandboxId);
}
