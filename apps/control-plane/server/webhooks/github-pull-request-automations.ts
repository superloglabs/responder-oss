import { findAutomationsForGitHubPullRequest } from "@responder/core/db/automations";
import { isMemberPullRequestBranch } from "@responder/core/db/github-pull-request-authors";
import { z } from "zod";
import { queueAutomationRun } from "../automations/queue.js";

// A pull request as GitHub's pull_request webhook sends it. Only the fields
// Responder reads are listed.
export const pullRequestAutomationEventSchema = z.object({
  action: z.string(),
  installation: z.object({ id: z.number().int().positive() }),
  pull_request: z.object({
    additions: z.number().int().optional(),
    author_association: z.string(),
    base: z.object({ ref: z.string().min(1) }),
    body: z.string().nullable(),
    changed_files: z.number().int().optional(),
    deletions: z.number().int().optional(),
    draft: z.boolean().optional(),
    head: z.object({ ref: z.string().min(1), sha: z.string().min(1) }),
    html_url: z.string().url(),
    labels: z.array(z.object({ name: z.string() })).optional(),
    merge_commit_sha: z.string().nullable().optional(),
    merged: z.boolean().optional(),
    merged_by: z.object({ login: z.string().min(1) }).nullable().optional(),
    number: z.number().int().positive(),
    title: z.string(),
    user: z.object({ login: z.string().min(1), type: z.string() }).nullable(),
  }),
  repository: z.object({
    full_name: z.string().min(1),
    id: z.number().int().positive(),
    private: z.boolean(),
  }),
});

export type PullRequestAutomationEvent = z.infer<typeof pullRequestAutomationEventSchema>;
type PullRequestTriggerEvent = "merged" | "opened";

// Anyone can open a pull request on a public repository, and their text must
// not steer the agent. Merging does not make it trusted.
const trustedAssociations = new Set(["COLLABORATOR", "MEMBER", "OWNER"]);

// A draft counts as opened when it is marked ready for review.
function triggerEvent(event: PullRequestAutomationEvent): PullRequestTriggerEvent | null {
  const pullRequest = event.pull_request;
  if (event.action === "opened" && pullRequest.draft !== true) return "opened";
  if (event.action === "ready_for_review") return "opened";
  if (event.action === "closed" && pullRequest.merged === true) return "merged";
  return null;
}

// Fields are cut before serializing so the body stays JSON. A cut never
// splits a surrogate pair.
function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const end = /[\uD800-\uDBFF]/u.test(value[maxLength - 1] ?? "") ? maxLength - 1 : maxLength;
  return value.slice(0, end);
}

export function pullRequestBody(event: PullRequestAutomationEvent): string {
  const pullRequest = event.pull_request;
  return JSON.stringify(
    {
      repository: event.repository.full_name,
      number: pullRequest.number,
      title: truncate(pullRequest.title, 500),
      url: pullRequest.html_url,
      author: pullRequest.user?.login ?? null,
      authorAssociation: pullRequest.author_association,
      base: pullRequest.base.ref,
      head: pullRequest.head.ref,
      headSha: pullRequest.head.sha,
      labels: pullRequest.labels?.slice(0, 50).map((label) => truncate(label.name, 100)) ?? [],
      additions: pullRequest.additions ?? null,
      deletions: pullRequest.deletions ?? null,
      changedFiles: pullRequest.changed_files ?? null,
      ...(pullRequest.merged === true
        ? {
            mergedBy: pullRequest.merged_by?.login ?? null,
            mergeCommitSha: pullRequest.merge_commit_sha ?? null,
          }
        : {}),
      body: truncate(pullRequest.body ?? "", 60_000),
    },
    null,
    2,
  );
}

export type PullRequestAutomationOutcome =
  | { outcome: "ignored" }
  | { matchedAutomations: number; outcome: "matched" };

interface PullRequestAutomationDependencies {
  findAutomations: typeof findAutomationsForGitHubPullRequest;
  isMemberPullRequestBranch: typeof isMemberPullRequestBranch;
  queueAutomationRun: typeof queueAutomationRun;
}

const defaultDependencies: PullRequestAutomationDependencies = {
  findAutomations: findAutomationsForGitHubPullRequest,
  isMemberPullRequestBranch,
  queueAutomationRun,
};

// Starts each automation whose GitHub trigger watches the pull request's
// repository for this event, once per pull request and event.
export async function startPullRequestAutomations(
  payload: unknown,
  dependencies: PullRequestAutomationDependencies = defaultDependencies,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<PullRequestAutomationOutcome> {
  const parsed = pullRequestAutomationEventSchema.safeParse(payload);
  if (!parsed.success) return { outcome: "ignored" };
  const event = parsed.data;
  const kind = triggerEvent(event);
  if (!kind) return { outcome: "ignored" };
  const pullRequest = event.pull_request;
  if (!event.repository.private && !trustedAssociations.has(pullRequest.author_association)) {
    return { outcome: "ignored" };
  }
  if (kind === "opened") {
    // Pull requests Responder opens do not start runs, so an automation that
    // opens pull requests cannot start itself. Without the app's slug they
    // cannot be told apart, so no opened pull request starts a run.
    const appSlug = environment.GITHUB_APP_SLUG;
    if (!appSlug) {
      console.error(JSON.stringify({ event: "github_pull_request_trigger_skipped", reason: "missing_app_slug" }));
      return { outcome: "ignored" };
    }
    if (pullRequest.user?.login === `${appSlug}[bot]`) return { outcome: "ignored" };
  }

  const installationId = String(event.installation.id);
  const matches = await dependencies.findAutomations({
    event: kind,
    installationId,
    repositoryExternalId: String(event.repository.id),
  });
  // A pull request Responder opened with a member's account is reported as
  // the member's. Its branch tells it apart.
  if (
    kind === "opened" &&
    matches.length > 0 &&
    await dependencies.isMemberPullRequestBranch({
      branch: pullRequest.head.ref,
      repositoryFullName: event.repository.full_name,
    })
  ) {
    return { outcome: "ignored" };
  }
  await Promise.all(
    matches.map((match) =>
      dependencies.queueAutomationRun({
        automationId: match.automationId,
        trigger: {
          attributes: {
            author: pullRequest.user?.login ?? null,
            event: kind,
            integrationAccountId: match.integrationAccountId,
            pullRequestNumber: pullRequest.number,
            repository: event.repository.full_name,
            repositoryId: match.repositoryId,
          },
          body: pullRequestBody(event),
          // GitHub can deliver an event again, and a pull request opens and
          // merges once.
          externalEventId: `${installationId}:${event.repository.id}:${pullRequest.number}:${kind}`,
          provider: "github",
          sourceUrl: pullRequest.html_url,
          title: `${event.repository.full_name}#${pullRequest.number}: ${pullRequest.title}`.slice(0, 500),
        },
      })
    ),
  );
  return { matchedAutomations: matches.length, outcome: "matched" };
}
