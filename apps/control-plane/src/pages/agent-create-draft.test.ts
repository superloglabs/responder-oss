import { describe, expect, it } from "vitest";
import {
  draftForSessionStorage,
  workspaceSecretRecordIdsForDraft,
  type CreateDraft,
} from "./agent-create-draft";

const OPTIONS = {
  secrets: [
    {
      id: "secret-1",
      name: "STATUS_API_TOKEN",
      allowedHosts: ["status.example.com"],
    },
  ],
};

describe("agent draft persistence", () => {
  it("restores valid workspace secret selections and persists them again", () => {
    const workspaceSecretRecordIds = workspaceSecretRecordIdsForDraft(
      OPTIONS,
      {
        workspaceSecretRecordIds: ["secret-1", "deleted-secret"],
      },
      {},
    );
    const draft = {
      workspaceSecretRecordIds,
    } as CreateDraft;

    expect(workspaceSecretRecordIds).toEqual(["secret-1"]);
    expect(draftForSessionStorage(draft).workspaceSecretRecordIds).toEqual([
      "secret-1",
    ]);
  });
});
