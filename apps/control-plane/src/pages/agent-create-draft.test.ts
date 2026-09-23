import { describe, expect, it } from "vitest";
import {
  draftForSessionStorage,
  restoreTriggerSelection,
  restoredSentryProjects,
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
    {
      id: "secret-2",
      name: "STATUS_API_TOKEN",
      allowedHosts: ["other.example.com"],
    },
  ],
};

describe("agent draft persistence", () => {
  it("keeps an edited name and instructions when leaving to connect a provider", () => {
    const draft = { name: "Storage investigator", instructions: "Investigate storage errors.", workspaceSecretRecordIds: [] } as unknown as CreateDraft;
    expect(draftForSessionStorage(draft, OPTIONS)).toMatchObject({
      name: "Storage investigator",
      instructions: "Investigate storage errors.",
    });
  });

  it("restores valid workspace secret selections and persists them again", () => {
    const workspaceSecretRecordIds = workspaceSecretRecordIdsForDraft(
      OPTIONS,
      {
        workspaceSecretNames: ["STATUS_API_TOKEN", "DELETED_API_TOKEN"],
      },
      {},
    );
    const draft = {
      workspaceSecretRecordIds,
    } as CreateDraft;

    expect(workspaceSecretRecordIds).toEqual(["secret-1"]);
    expect(draftForSessionStorage(draft, OPTIONS).workspaceSecretNames).toEqual([
      "STATUS_API_TOKEN",
    ]);
  });

  it("restores and migrates a valid ID from a legacy session draft", () => {
    const workspaceSecretRecordIds = workspaceSecretRecordIdsForDraft(
      OPTIONS,
      { workspaceSecretRecordIds: ["secret-1", "deleted-secret"] },
      {},
    );
    const draft = { workspaceSecretRecordIds } as CreateDraft;

    expect(workspaceSecretRecordIds).toEqual(["secret-1"]);
    expect(draftForSessionStorage(draft, OPTIONS)).toMatchObject({
      workspaceSecretNames: ["STATUS_API_TOKEN"],
    });
    expect(draftForSessionStorage(draft, OPTIONS)).not.toHaveProperty(
      "workspaceSecretRecordIds",
    );
  });
});

describe("trigger restoration after connecting", () => {
  it("keeps the Sentry input and output requirement on new-agent return", () => {
    expect(restoreTriggerSelection({ inputKind: "sentry_issue", outputMode: "thread" }, {})).toEqual({ inputKind: "sentry_issue", outputMode: "output_channel" });
  });
  it("keeps an unsaved trigger change ahead of the saved agent", () => {
    expect(restoreTriggerSelection({ inputKind: "dash0_alert" }, { inputKind: "slack_channel", outputMode: "thread" })).toEqual({ inputKind: "dash0_alert", outputMode: "output_channel" });
  });
  it("preserves Slack channel reporting across authorization", () => {
    expect(restoreTriggerSelection({ inputKind: "slack_channel", outputMode: "output_channel" }, {})).toEqual({ inputKind: "slack_channel", outputMode: "output_channel" });
  });
});

describe("connection selection preservation", () => {
  it("retains all valid project selections after reauthorizing the same account", () => {
    expect(restoredSentryProjects(["b", "c", "gone"], ["a", "b", "c"])).toEqual(["b", "c"]);
  });
  it("selects the first project only when no draft project survives", () => {
    expect(restoredSentryProjects(["gone"], ["a", "b"])).toEqual(["a"]);
  });
});
