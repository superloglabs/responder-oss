export interface SuperuserListCell {
  id: string;
  label: string;
  url: string;
}

export interface SuperuserListUser {
  banned: boolean | null;
  canImpersonate: boolean;
  // The cell that holds the user, or null when there is only one cell.
  cell: SuperuserListCell | null;
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

// The query parameter that asks a cell's user support page to view as one of
// its users. The page only acts on a user it loaded from its own cell.
export const viewAsUserParameter = "view";

/**
 * A user in another cell is viewed from that cell, which holds their account
 * and the superuser's session there. Null for a user of this cell.
 */
export function otherCellViewUrl(
  user: Pick<SuperuserListUser, "cell" | "email" | "id">,
  currentCell: string | null,
): string | null {
  if (!user.cell || user.cell.id === currentCell) return null;
  const url = new URL("/superuser/users", user.cell.url);
  url.searchParams.set("search", user.email);
  url.searchParams.set(viewAsUserParameter, user.id);
  return url.toString();
}

/** The listed user of this cell that a handed-over link asks to view as. */
export function requestedViewUser(
  users: SuperuserListUser[],
  requestedId: string | null,
  currentCell: string | null,
): SuperuserListUser | null {
  if (!requestedId) return null;
  return (
    users.find(
      (user) =>
        user.id === requestedId &&
        (user.cell === null || user.cell.id === currentCell),
    ) ?? null
  );
}
