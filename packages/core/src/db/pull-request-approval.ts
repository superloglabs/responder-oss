import { eq } from "drizzle-orm";
import { getDatabase } from "./client.js";
import { pullRequestApprovalSettings } from "./schema.js";

type Database = Pick<ReturnType<typeof getDatabase>, "select">;

// Whether pull requests from runs that an outside event started wait for a
// workspace member. Off unless an administrator turned it on.
export async function pullRequestApprovalRequired(
  organizationId: string,
  db: Database = getDatabase(),
): Promise<boolean> {
  const [row] = await db
    .select({ requireApproval: pullRequestApprovalSettings.requireApproval })
    .from(pullRequestApprovalSettings)
    .where(eq(pullRequestApprovalSettings.organizationId, organizationId))
    .limit(1);
  return row?.requireApproval ?? false;
}

export async function savePullRequestApprovalRequired(
  organizationId: string,
  requireApproval: boolean,
): Promise<void> {
  const updatedAt = new Date();
  await getDatabase()
    .insert(pullRequestApprovalSettings)
    .values({ organizationId, requireApproval, updatedAt })
    .onConflictDoUpdate({
      target: pullRequestApprovalSettings.organizationId,
      set: { requireApproval, updatedAt },
    });
}
