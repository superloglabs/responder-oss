import { desc, eq, ilike } from "drizzle-orm";
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

/** A user as the user support page lists them. */
export interface SupportUserRecord {
  banned: boolean | null;
  createdAt: Date;
  email: string;
  id: string;
  image: string | null;
  name: string;
  role: string | null;
}

/** The newest users, or those whose email contains the search. */
export async function listSupportUsers(
  search: string | undefined,
  limit = 50,
): Promise<SupportUserRecord[]> {
  // LIKE's wildcards in the search match as written.
  const pattern = search
    ? `%${search.replace(/[\\%_]/gu, (character) => `\\${character}`)}%`
    : null;
  return getDatabase()
    .select({
      banned: user.banned,
      createdAt: user.createdAt,
      email: user.email,
      id: user.id,
      image: user.image,
      name: user.name,
      role: user.role,
    })
    .from(user)
    .where(pattern ? ilike(user.email, pattern) : undefined)
    .orderBy(desc(user.createdAt))
    .limit(limit);
}

export async function setPlatformRole(
  userId: string,
  role: PlatformRole,
): Promise<void> {
  await getDatabase().update(user).set({ role }).where(eq(user.id, userId));
}
