import type { AgentOptions, AgentPrMode } from "../agents-api";

export type InputKind = "sentry_issue" | "slack_channel";
export type OutputMode = "thread" | "output_channel";
export type Severity = "SEV-1" | "SEV-2" | "SEV-3";

export interface CreateDraft {
  inputKind: InputKind;
  sentryAccountId: string;
  sentryProjectResourceIds: string[];
  slackInputResourceId: string;
  outputMode: OutputMode;
  outputChannelResourceId: string;
  severities: Severity[];
  githubAccountId: string;
  repositoryIds: string[];
  prMode: AgentPrMode;
  contextAccountIds: string[];
  contextResourceIds: string[];
  workspaceSecretRecordIds: string[];
  createLinearTickets: boolean;
  linearIssueTemplate: string;
  instructions: string;
}

export type SavedCreateDraft = Partial<CreateDraft> & {
  postScope?: "all" | "selected";
};

export function draftForSessionStorage(draft: CreateDraft): SavedCreateDraft {
  return {
    inputKind: draft.inputKind,
    sentryAccountId: draft.sentryAccountId,
    sentryProjectResourceIds: draft.sentryProjectResourceIds,
    slackInputResourceId: draft.slackInputResourceId,
    outputMode: draft.outputMode,
    outputChannelResourceId: draft.outputChannelResourceId,
    severities: draft.severities,
    githubAccountId: draft.githubAccountId,
    repositoryIds: draft.repositoryIds,
    prMode: draft.prMode,
    contextAccountIds: draft.contextAccountIds,
    contextResourceIds: draft.contextResourceIds,
    workspaceSecretRecordIds: draft.workspaceSecretRecordIds,
    createLinearTickets: draft.createLinearTickets,
    linearIssueTemplate: draft.linearIssueTemplate,
    instructions: draft.instructions,
  };
}

export function workspaceSecretRecordIdsForDraft(
  options: Pick<AgentOptions, "secrets">,
  saved: SavedCreateDraft,
  configured: Partial<CreateDraft>,
): string[] {
  const selectedIds =
    saved.workspaceSecretRecordIds ?? configured.workspaceSecretRecordIds;

  return selectedIds?.filter((id) =>
    options.secrets.some((secret) => secret.id === id),
  ) ?? [];
}
