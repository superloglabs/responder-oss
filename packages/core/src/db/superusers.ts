import { eq } from "drizzle-orm";
import { user } from "./auth-schema.js";
import { getDatabase } from "./client.js";

export type PlatformRole = "superuser" | "user";

export interface AuthUserSupportIdentity {
  banned: boolean | null;
  email: string;
  emailVerified: boolean;
  role: string | null;
}

export async function getAuthUserSupportIdentity(
  userId: string,
): Promise<AuthUserSupportIdentity | null> {
  const [record] = await getDatabase()
    .select({
      banned: user.banned,
      email: user.email,
      emailVerified: user.emailVerified,
      role: user.role,
    })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return record ?? null;
}

export async function setPlatformRole(
  userId: string,
  role: PlatformRole,
): Promise<void> {
  await getDatabase().update(user).set({ role }).where(eq(user.id, userId));
}
