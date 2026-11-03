import { z } from "zod";
import type { Cell, CellDirectory } from "../../../../packages/core/src/cells.js";
import {
  maxMemberWorkspaces,
  type MemberWorkspace,
} from "../../../../packages/core/src/db/member-workspaces.js";

// A person who signs in to a cell where they have no workspace may belong to
// one in another cell. The cell they signed in to asks the others with the
// shared cell token, so the sign-in page can send them to their workspace
// instead of asking them to create one.

export const memberWorkspaceSearchSchema = z.object({
  email: z.email().max(320),
});

export type WorkspaceInCell = MemberWorkspace & { cell: Cell };

const workspaceListSchema = z.array(
  z.object({ name: z.string().max(200), slug: z.string().max(200) }),
).max(maxMemberWorkspaces);

export async function askCellForMemberWorkspaces(
  cell: Cell,
  email: string,
  token: string,
): Promise<MemberWorkspace[]> {
  const response = await fetch(new URL("/api/internal/cells/member-workspaces", cell.url), {
    body: JSON.stringify({ email }),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Cell ${cell.id} answered ${response.status}`);
  const answer = workspaceListSchema.safeParse(
    ((await response.json()) as { workspaces?: unknown }).workspaces,
  );
  if (!answer.success) throw new Error(`Cell ${cell.id} sent no workspaces`);
  return answer.data;
}

// The workspaces the address belongs to in the other cells. A cell that
// cannot answer is left out, so the person can still set up a workspace here.
export async function workspacesInOtherCells({
  askCell = askCellForMemberWorkspaces,
  directory,
  email,
  token,
}: {
  askCell?: typeof askCellForMemberWorkspaces;
  directory: CellDirectory | null;
  email: string;
  token: string | undefined;
}): Promise<WorkspaceInCell[]> {
  if (!directory || !token) return [];
  const others = directory.cells.filter((cell) => cell.id !== directory.current);
  const answers = await Promise.allSettled(
    others.map((cell) => askCell(cell, email, token)),
  );
  const workspaces: WorkspaceInCell[] = [];
  answers.forEach((answer, index) => {
    const cell = others[index];
    if (answer.status === "fulfilled") {
      workspaces.push(...answer.value.map((workspace) => ({ ...workspace, cell })));
      return;
    }
    console.error(
      JSON.stringify({
        cell: cell.id,
        errorMessage:
          answer.reason instanceof Error ? answer.reason.message : String(answer.reason),
        event: "member_workspaces_cell_unavailable",
      }),
    );
  });
  return workspaces;
}
