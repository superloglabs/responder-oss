import type {
  AutomationPullRequest,
  PullRequestConversationEntry,
  PullRequestState,
} from "./pull-requests-api";

export const pullRequestStateLabels: Record<PullRequestState, string> = {
  closed: "Closed",
  draft: "Draft",
  merged: "Merged",
  open: "Open",
};

const reviewLabels: Record<Extract<PullRequestConversationEntry, { kind: "review" }>["state"], string> = {
  approved: "approved these changes",
  changes_requested: "requested changes",
  commented: "reviewed",
  dismissed: "left a dismissed review",
};

export function conversationAction(entry: PullRequestConversationEntry): string {
  return entry.kind === "comment" ? "commented" : reviewLabels[entry.state];
}

export function pullRequestTitle(pullRequest: Pick<AutomationPullRequest, "title">): string {
  return pullRequest.title?.trim() || "Pull request";
}

// "acme/api #42", from the URL when the recorded repository is missing.
export function pullRequestReference(pullRequest: Pick<AutomationPullRequest, "number" | "repository" | "url">): string {
  const repository = pullRequest.repository
    ?? /^https:\/\/github\.com\/([^/]+\/[^/]+)\//u.exec(pullRequest.url)?.[1]
    ?? "GitHub";
  return pullRequest.number ? `${repository} #${pullRequest.number}` : repository;
}

// A commit message's first line is its title; the rest is its description.
export function commitMessageParts(message: string): { description: string; title: string } {
  const [title = "", ...rest] = message.split("\n");
  return { description: rest.join("\n").trim(), title: title.trim() };
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function lineCountLabel(additions: number, deletions: number, changedFiles: number): string {
  return `+${additions.toLocaleString()} −${deletions.toLocaleString()} · ${changedFiles.toLocaleString()} ${changedFiles === 1 ? "file" : "files"}`;
}
