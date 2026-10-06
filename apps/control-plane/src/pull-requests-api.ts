import { apiErrorMessage } from "./agents-api";
import type {
  PullRequestCommit,
  PullRequestConversationEntry,
  PullRequestDetail,
  PullRequestPerson,
  PullRequestState,
} from "../server/pull-requests/github";

export type {
  PullRequestCommit,
  PullRequestConversationEntry,
  PullRequestDetail,
  PullRequestPerson,
  PullRequestState,
};

// A pull request an automation run opened.
export interface AutomationPullRequest {
  automationId: string;
  automationName: string;
  createdAt: string;
  id: string;
  number: number | null;
  repository: string | null;
  runId: string;
  title: string | null;
  url: string;
}

export interface AutomationPullRequestListItem extends AutomationPullRequest {
  // Null when GitHub could not be read.
  state: PullRequestState | null;
}

export interface AutomationPullRequestPage {
  page: number;
  pageSize: number;
  pullRequests: AutomationPullRequestListItem[];
  total: number;
}

export interface AutomationPullRequestDetail {
  github: PullRequestDetail | null;
  githubError: string | null;
  pullRequest: AutomationPullRequest;
}

async function pullRequestJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const body = (await response.json().catch(() => null)) as T | null;
  if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
  return body as T;
}

export function fetchPullRequests(page: number): Promise<AutomationPullRequestPage> {
  return pullRequestJson(`/api/pull-requests?page=${page}`);
}

export function fetchPullRequest(id: string): Promise<AutomationPullRequestDetail> {
  return pullRequestJson(`/api/pull-requests/${encodeURIComponent(id)}`);
}
