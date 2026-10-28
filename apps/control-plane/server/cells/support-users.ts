import { z } from "zod";
import type { Cell, CellDirectory } from "../../../../packages/core/src/cells.js";
import type { SupportUserRecord } from "../../../../packages/core/src/db/superusers.js";
import { canImpersonateSupportUser } from "../auth.js";

// The user support page lists the users of every cell. The cell that serves
// the page asks the others with the shared cell token; each cell decides on
// its own whether one of its users may be impersonated.

export const supportUserSearchSchema = z.object({
  search: z.string().trim().max(320).optional(),
});

export type SupportUser = Omit<SupportUserRecord, "createdAt"> & {
  canImpersonate: boolean;
  createdAt: string;
};

export type CellSupportUser = SupportUser & { cell: Cell | null };

export type SupportUsersAcrossCells = {
  // Null when the deployment runs a single cell.
  currentCell: string | null;
  unavailableCells: Cell[];
  users: CellSupportUser[];
};

export function supportUsers(
  records: SupportUserRecord[],
  superuserEmails: ReadonlySet<string>,
): SupportUser[] {
  return records.map((record) => ({
    ...record,
    canImpersonate: canImpersonateSupportUser(record, superuserEmails),
    createdAt: record.createdAt.toISOString(),
  }));
}

export async function askCellForSupportUsers(
  cell: Cell,
  search: string | undefined,
  token: string,
): Promise<SupportUser[]> {
  const response = await fetch(new URL("/api/internal/cells/support-users", cell.url), {
    body: JSON.stringify(search ? { search } : {}),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Cell ${cell.id} answered ${response.status}`);
  const answer = (await response.json()) as { users?: unknown };
  if (!Array.isArray(answer.users)) throw new Error(`Cell ${cell.id} sent no users`);
  return answer.users as SupportUser[];
}

export async function supportUsersAcrossCells({
  askCell = askCellForSupportUsers,
  directory,
  local,
  search,
  token,
}: {
  askCell?: typeof askCellForSupportUsers;
  directory: CellDirectory | null;
  local: SupportUser[];
  search: string | undefined;
  token: string | undefined;
}): Promise<SupportUsersAcrossCells> {
  if (!directory) {
    return {
      currentCell: null,
      unavailableCells: [],
      users: local.map((user) => ({ ...user, cell: null })),
    };
  }

  const current = directory.cells.find((cell) => cell.id === directory.current) ?? null;
  const others = directory.cells.filter((cell) => cell.id !== directory.current);
  const answers = await Promise.allSettled(
    others.map((cell) =>
      token
        ? askCell(cell, search, token)
        : Promise.reject(new Error("RESPONDER_CELL_TOKEN is not set")),
    ),
  );

  const users: CellSupportUser[] = local.map((user) => ({ ...user, cell: current }));
  const unavailableCells: Cell[] = [];
  answers.forEach((answer, index) => {
    const cell = others[index];
    if (answer.status === "fulfilled") {
      users.push(...answer.value.map((user) => ({ ...user, cell })));
      return;
    }
    // One unreachable cell does not hide the others' users.
    unavailableCells.push(cell);
    console.error(
      JSON.stringify({
        cell: cell.id,
        errorMessage:
          answer.reason instanceof Error ? answer.reason.message : String(answer.reason),
        event: "support_users_cell_unavailable",
      }),
    );
  });

  users.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return { currentCell: directory.current, unavailableCells, users };
}
