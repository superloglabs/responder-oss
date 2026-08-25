export type TriggerKind =
  | "sentry_issue"
  | "datadog_monitor"
  | "slack_channel"
  | "slack_mention";

export type AgentPrMode = "disabled" | "manual" | "always";

export type AgentTrigger =
  | {
      kind: "sentry_issue";
      integrationAccountId: string;
      projectIds: string[];
    }
  | {
      kind: "datadog_monitor";
      integrationAccountId: string;
      monitorIds: string[];
    }
  | {
      kind: "slack_channel";
      integrationAccountId: string;
      channelId: string;
    }
  | {
      kind: "slack_mention";
      integrationAccountId: string;
      channelIds: string[];
    };

export type AgentReporting =
  | { mode: "thread" }
  | {
      mode: "output_channel" | "both";
      integrationAccountId: string;
      outputChannelId: string;
      severities?: Array<"SEV-1" | "SEV-2" | "SEV-3">;
    };

export interface AgentConfiguration {
  name: string;
  description: string;
  model: string;
  instructions: string;
  enabled: boolean;
  prMode: AgentPrMode;
  repositoryIds: string[];
  contextAccountIds: string[];
  contextResourceIds: string[];
  secretIds: string[];
  createLinearTickets: boolean;
  linearIssueTemplate: string;
  trigger: AgentTrigger;
  reporting: AgentReporting;
}

export interface AgentOptions {
  accounts: Array<{
    id: string;
    provider:
      | "aws"
      | "github"
      | "slack"
      | "sentry"
      | "datadog"
      | "axiom"
      | "clickstack"
      | "upstash"
      | "langfuse"
      | "vercel"
      | "custom_mcp"
      | "linear";
    displayName: string;
    slackContextAvailable?: boolean;
  }>;
  resources: Array<{
    id: string;
    integrationAccountId: string;
    kind:
      | "slack_channel"
      | "sentry_project"
      | "datadog_monitor"
      | "vercel_project";
    externalId: string;
    displayName: string;
  }>;
  repositories: Array<{
    id: string;
    integrationAccountId: string;
    fullName: string;
    defaultBranch: string;
    private: boolean;
  }>;
  secrets: Array<{
    id: string;
    name: string;
    allowedHosts: string[];
  }>;
}

export interface AgentListItem {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  updatedAt: string;
  activeVersionId: string | null;
  trigger: TriggerKind | null;
  triggerConfig: Record<string, unknown> | null;
  reportConfig: AgentReporting | null;
  prMode: AgentPrMode | null;
  repositoryCount: number;
  latestRun: {
    agentId: string;
    status: "pending" | "investigating" | "resolved" | "failed";
    createdAt: string;
  } | null;
}

export interface IntegrationSummary {
  id:
    | "aws"
    | "github"
    | "slack"
    | "sentry"
    | "datadog"
    | "axiom"
    | "upstash"
    | "langfuse"
    | "vercel"
    | "custom_mcp"
    | "clickstack"
    | "linear";
  name: string;
  description: string;
  state: "available" | "coming_soon" | "connected" | "setup_required";
  accountCount: number;
  resourceCount: number;
  accounts?: Array<{
    id: string;
    displayName: string;
    status: "connected" | "error" | "pending";
    resourceCount: number;
    updatedAt: string;
  }>;
  connectUrl: string | null;
  configurationUrl: string | null;
}

export interface AgentDetail {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  versionId: string | null;
  version: number | null;
  configuration: AgentConfiguration | null;
  repositories: AgentOptions["repositories"];
  investigations: Array<{
    id: string;
    title: string;
    status: "pending" | "investigating" | "resolved" | "failed";
    input: {
      provider: "sentry" | "datadog" | "slack";
      externalEventId: string;
      title: string;
      body: string;
      sourceUrl?: string;
    };
    finding: {
      summary: string;
    } | null;
    failureReason: string | null;
    isReplay: boolean;
    replayOfInvestigationId: string | null;
    createdAt: string;
    completedAt: string | null;
  }>;
}

export interface InvestigationTraceEvent {
  type: string;
  data?: unknown;
  meta?: {
    at?: string;
  };
}

export interface IssueEvidence {
  source:
    | "alert"
    | "aws"
    | "datadog"
    | "axiom"
    | "sentry"
    | "clickstack"
    | "upstash"
    | "langfuse"
    | "github"
    | "slack"
    | "vercel"
    | "other";
  title: string;
  detail: string;
  url?: string;
  file?: string;
  line?: number;
  toolCallId?: string;
}

export type IssueRemediation =
  | {
      id: string;
      type: "code_change";
      title: string;
      description: string;
      diff: string;
    }
  | {
      id: string;
      type: "external_action";
      title: string;
      description: string;
      agentPrompt: string;
    };

export interface IssuePullRequestActivity {
  id: number;
  event: {
    type:
      | "review.comment.received"
      | "review.job.queued"
      | "review.session.started"
      | "review.trace"
      | "review.commit.pushed"
      | "review.threads.addressed"
      | "review.session.completed"
      | "review.session.failed";
    data?: Record<string, unknown>;
    meta: { at: string };
  };
  createdAt: string;
}

export interface IssueListItem {
  id: string;
  title: string;
  description: string;
  rootCause: string;
  timeline: Array<{ title: string; description: string }>;
  severity: "SEV-1" | "SEV-2" | "SEV-3";
  remediation: string;
  remediations: IssueRemediation[];
  archivedAt: string | null;
  createdAt: string;
}

export interface IssueDetailResponse {
  issue: IssueListItem & {
    evidence: IssueEvidence[];
  };
  investigations: Array<{
    id: string;
    agentId: string;
    agentName: string;
    title: string;
    status: "pending" | "investigating" | "resolved" | "failed";
    relationship: "new" | "recurrence";
    evidence: IssueEvidence[];
    createdAt: string;
    completedAt: string | null;
  }>;
  linearTicketState: {
    requests: Array<{
      id: string;
      status: "pending" | "creating" | "created" | "failed";
      teamId: string | null;
      projectId: string | null;
      linearIssueId: string | null;
      linearIdentifier: string | null;
      linearIssueUrl: string | null;
      failureReason: string | null;
      attemptCount: number;
      createdAt: string;
      updatedAt: string;
      completedAt: string | null;
    }>;
  };
  pullRequestState: {
    canCreate: boolean;
    requests: Array<{
      id: string;
      remediationId: string | null;
      repositoryFullName: string | null;
      status: "queued" | "creating" | "created" | "merged" | "failed";
      branch: string | null;
      pullRequestNumber: number | null;
      pullRequestUrl: string | null;
      failureReason: string | null;
      createdAt: string;
      updatedAt: string;
      completedAt: string | null;
      activities: IssuePullRequestActivity[];
    }>;
  };
}

export interface InvestigationDetail {
  id: string;
  agentId: string;
  title: string;
  status: "pending" | "investigating" | "resolved" | "failed";
  input: {
    provider: "sentry" | "datadog" | "slack";
    externalEventId: string;
    title: string;
    body: string;
    sourceUrl?: string;
    attributes?: Record<string, unknown>;
  };
  finding: {
    summary: string;
    remediation: string;
    evidence: string[];
    pullRequestUrl?: string;
  } | null;
  structuredReport: {
    schemaVersion: 1;
    headline: string;
    summary: string;
    issues: Array<{
      issueId: string;
      relationship: "new" | "recurrence";
      evidence: IssueEvidence[];
    }>;
  } | null;
  replayReport: {
    headline: string;
    summary: string;
    issues: Array<{
      resolution: "new" | "existing";
      issueId?: string;
      title?: string;
      description?: string;
      severity?: "SEV-1" | "SEV-2" | "SEV-3";
      remediation?: string;
      evidence: IssueEvidence[];
    }>;
  } | null;
  isReplay: boolean;
  replayOfInvestigationId: string | null;
  issues: Array<{
    id: string;
    title: string;
    description: string;
    severity: "SEV-1" | "SEV-2" | "SEV-3";
    remediation: string;
    relationship: "new" | "recurrence";
    evidence: IssueEvidence[];
    createdAt: string;
  }>;
  reportMarkdown: string | null;
  eveSessionId: string | null;
  failureReason: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InvestigationDetailResponse {
  investigation: InvestigationDetail;
  trace: {
    events: InvestigationTraceEvent[];
    sessionId: string | null;
    truncated: boolean;
  };
  traceError: string | null;
}

export function apiErrorMessage(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const errorBody = body as Record<string, unknown>;
    if (Array.isArray(errorBody.issues)) {
      const issueMessages = [
        ...new Set(
          errorBody.issues.flatMap((issue) => {
            if (!issue || typeof issue !== "object") return [];
            const message = (issue as Record<string, unknown>).message;
            return typeof message === "string" && message.trim()
              ? [message.trim()]
              : [];
          }),
        ),
      ];
      if (issueMessages.length > 0) return issueMessages.join(". ");
    }

    if (typeof errorBody.error === "string" && errorBody.error.trim()) {
      return errorBody.error;
    }
  }

  return `Request failed (${status})`;
}

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => null)) as T | null;
  if (!response.ok) {
    throw new Error(apiErrorMessage(body, response.status));
  }
  return body as T;
}

export async function fetchAgents(): Promise<AgentListItem[]> {
  const response = await apiJson<{ agents: AgentListItem[] }>("/api/agents");
  return response.agents;
}

export async function fetchAgent(agentId: string): Promise<AgentDetail> {
  const response = await apiJson<{ agent: AgentDetail }>(
    `/api/agents/${encodeURIComponent(agentId)}`,
  );
  return response.agent;
}

export async function setAgentEnabled(
  agentId: string,
  enabled: boolean,
): Promise<{ agentId: string; enabled: boolean }> {
  return apiJson<{ agentId: string; enabled: boolean }>(
    `/api/agents/${encodeURIComponent(agentId)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
    },
  );
}

export async function fetchInvestigation(
  agentId: string,
  investigationId: string,
): Promise<InvestigationDetailResponse> {
  return apiJson<InvestigationDetailResponse>(
    `/api/agents/${encodeURIComponent(agentId)}/investigations/${encodeURIComponent(investigationId)}`,
  );
}

export async function fetchIssues(
  showArchived = false,
): Promise<IssueListItem[]> {
  const response = await apiJson<{ issues: IssueListItem[] }>(
    `/api/issues${showArchived ? "?showArchived=true" : ""}`,
  );
  return response.issues;
}

export async function fetchIssue(issueId: string): Promise<IssueDetailResponse> {
  return apiJson<IssueDetailResponse>(
    `/api/issues/${encodeURIComponent(issueId)}`,
  );
}

export async function setIssueArchived(
  issueId: string,
  archived: boolean,
): Promise<{ archivedAt: string | null; id: string }> {
  const response = await apiJson<{
    issue: { archivedAt: string | null; id: string };
  }>(`/api/issues/${encodeURIComponent(issueId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ archived }),
  });
  return response.issue;
}

export async function createIssuePullRequest(
  issueId: string,
  remediationId: string,
): Promise<{ requestId: string; sessionId: string | null }> {
  return apiJson<{ requestId: string; sessionId: string | null }>(
    `/api/issues/${encodeURIComponent(issueId)}/pull-requests`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ remediationId }),
    },
  );
}

export async function retryInvestigation(
  agentId: string,
  investigationId: string,
): Promise<{ investigationId: string; sessionId: string | null }> {
  return apiJson<{ investigationId: string; sessionId: string | null }>(
    `/api/agents/${encodeURIComponent(agentId)}/investigations/${encodeURIComponent(investigationId)}/retry`,
    { method: "POST" },
  );
}

export async function fetchAgentOptions(): Promise<AgentOptions> {
  return apiJson<AgentOptions>("/api/agents/options");
}

export async function refreshSlackAgentOptions(): Promise<AgentOptions> {
  return apiJson<AgentOptions>("/api/agents/options/refresh/slack", {
    method: "POST",
  });
}

export async function refreshGitHubAgentOptions(): Promise<AgentOptions> {
  return apiJson<AgentOptions>("/api/agents/options/refresh/github", {
    method: "POST",
  });
}

export async function createWorkspaceSecret(input: {
  name: string;
  value: string;
  allowedHosts: string[];
}): Promise<AgentOptions["secrets"][number]> {
  const response = await apiJson<{
    secret: AgentOptions["secrets"][number];
  }>("/api/agents/secrets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return response.secret;
}

export async function fetchIntegrations(): Promise<IntegrationSummary[]> {
  const response = await apiJson<{ integrations: IntegrationSummary[] }>(
    "/api/integrations",
  );
  return response.integrations;
}

export async function saveAgent(
  agentId: string | undefined,
  configuration: AgentConfiguration,
): Promise<string> {
  const response = await apiJson<{ agentId: string }>(
    agentId
      ? `/api/agents/${encodeURIComponent(agentId)}`
      : "/api/agents",
    {
      method: agentId ? "PUT" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(configuration),
    },
  );
  return response.agentId;
}

export function slackChannelLabel(displayName: string): string {
  return displayName.startsWith("#") ? displayName : `#${displayName}`;
}

export function triggerLabel(trigger: TriggerKind | null): string {
  switch (trigger) {
    case "sentry_issue":
      return "Every Sentry error";
    case "datadog_monitor":
      return "Datadog monitor";
    case "slack_channel":
      return "Slack channel";
    case "slack_mention":
      return "@Responder mention";
    default:
      return "Not configured";
  }
}

export function relativeTime(value: string): string {
  const elapsed = Date.now() - new Date(value).getTime();
  if (elapsed < 60_000) return "Just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  if (elapsed < 7 * 86_400_000) {
    return `${Math.floor(elapsed / 86_400_000)}d ago`;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}
