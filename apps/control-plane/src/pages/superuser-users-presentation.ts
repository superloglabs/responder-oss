export interface SuperuserListUser {
  banned: boolean | null;
  canImpersonate: boolean;
  createdAt: Date | string;
  email: string;
  id: string;
  image?: string | null;
  name: string;
  role?: string | null;
}

export function isSuperuserRole(role: string | null | undefined): boolean {
  return role?.split(",").includes("superuser") ?? false;
}

export function canImpersonateUser(
  user: Pick<SuperuserListUser, "canImpersonate">,
): boolean {
  return user.canImpersonate;
}
