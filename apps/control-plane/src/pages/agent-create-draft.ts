import type { AgentOptions, AgentPrMode } from "../agents-api";

export type InputKind = "sentry_issue" | "dash0_alert" | "slack_channel";
export type OutputMode = "thread" | "output_channel";
export type Severity = "SEV-1" | "SEV-2" | "SEV-3";

export interface CreateDraft {
  name?: string;
  inputKind: InputKind;
  sentryAccountId: string;
  sentryProjectResourceIds: string[];
  dash0AccountId: string;
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
  initialTriageEnabled: boolean;
  createLinearTickets: boolean;
  linearIssueTemplate: string;
  instructions: string;
}

export type SavedCreateDraft = Partial<
  Omit<CreateDraft, "workspaceSecretRecordIds">
> & {
  postScope?: "all" | "selected";
  workspaceSecretRecordIds?: string[];
  workspaceSecretNames?: string[];
};

export function draftForSessionStorage(
  draft: CreateDraft,
  options: Pick<AgentOptions, "secrets">,
): SavedCreateDraft {
  return {
    name: draft.name,
    inputKind: draft.inputKind,
    sentryAccountId: draft.sentryAccountId,
    sentryProjectResourceIds: draft.sentryProjectResourceIds,
    dash0AccountId: draft.dash0AccountId,
    slackInputResourceId: draft.slackInputResourceId,
    outputMode: draft.outputMode,
    outputChannelResourceId: draft.outputChannelResourceId,
    severities: draft.severities,
    githubAccountId: draft.githubAccountId,
    repositoryIds: draft.repositoryIds,
    prMode: draft.prMode,
    contextAccountIds: draft.contextAccountIds,
    contextResourceIds: draft.contextResourceIds,
    initialTriageEnabled: draft.initialTriageEnabled,
    workspaceSecretNames: options.secrets
      .filter((secret) => draft.workspaceSecretRecordIds.includes(secret.id))
      .map((secret) => secret.name),
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
  if (saved.workspaceSecretNames) {
    return [...new Set(saved.workspaceSecretNames)].flatMap((name) => {
      const secret = options.secrets.find((candidate) => candidate.name === name);
      return secret ? [secret.id] : [];
    });
  }

  if (saved.workspaceSecretRecordIds) {
    return saved.workspaceSecretRecordIds.filter((id) =>
      options.secrets.some((secret) => secret.id === id),
    );
  }

  return configured.workspaceSecretRecordIds?.filter((id) =>
    options.secrets.some((secret) => secret.id === id),
  ) ?? [];
}

/** Restore the input before resource selection, including an interrupted OAuth setup. */
export function restoreTriggerSelection(saved: SavedCreateDraft, configured: Partial<CreateDraft>): Pick<CreateDraft, "inputKind" | "outputMode"> {
  const inputKind = saved.inputKind ?? configured.inputKind ?? "slack_channel";
  return { inputKind, outputMode: inputKind === "slack_channel" ? saved.outputMode ?? configured.outputMode ?? "thread" : "output_channel" };
}

export function restoredSentryProjects(selected: string[], available: string[]): string[] {
  const preserved = selected.filter((id) => available.includes(id));
  return preserved.length > 0 ? preserved : available.slice(0, 1);
}
