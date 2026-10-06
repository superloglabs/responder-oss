import { z } from "zod";
import {
  createGitHubInstallationToken,
  githubAppHeaders,
} from "../../../../packages/core/src/integrations/github.js";

const githubApiUrl = "https://api.github.com";
const requestTimeoutMs = 10_000;
// Up to 1,000 comments or commits per list; GitHub itself lists at most 250
// commits for a pull request.
const maxPages = 10;
// GitHub lists at most 3,000 changed files for a pull request.
const maxFilePages = 30;

export interface PullRequestReference {
  number: number;
  owner: string;
  repo: string;
}

export type PullRequestState = "closed" | "draft" | "merged" | "open";

export interface PullRequestPerson {
  avatarUrl: string | null;
  login: string;
}

export interface PullRequestInlineComment {
  body: string;
  createdAt: string;
  id: number;
  line: number | null;
  path: string;
  url: string;
}

export type PullRequestConversationEntry =
  | {
      author: PullRequestPerson | null;
      body: string;
      createdAt: string;
      id: number;
      kind: "comment";
      url: string;
    }
  | {
      author: PullRequestPerson | null;
      body: string;
      comments: PullRequestInlineComment[];
      createdAt: string;
      id: number;
      kind: "review";
      state: "approved" | "changes_requested" | "commented" | "dismissed";
      url: string;
    };

export interface PullRequestCommit {
  author: PullRequestPerson | null;
  authorName: string | null;
  committedAt: string | null;
  message: string;
  sha: string;
  url: string;
}

// A changed file. GitHub leaves out the patch of a binary file, a file
// renamed without changes, and a file whose diff is too large.
export interface PullRequestFile {
  additions: number;
  deletions: number;
  filename: string;
  patch: string | null;
  previousFilename: string | null;
  status: "added" | "changed" | "copied" | "modified" | "removed" | "renamed" | "unchanged";
}

export interface PullRequestDetail {
  additions: number;
  author: PullRequestPerson | null;
  baseBranch: string;
  body: string;
  changedFiles: number;
  closedAt: string | null;
  commits: PullRequestCommit[];
  conversation: PullRequestConversationEntry[];
  // GitHub has more comments or reviews than the page reads.
  conversationTruncated: boolean;
  createdAt: string;
  deletions: number;
  headBranch: string;
  mergedAt: string | null;
  state: PullRequestState;
  title: string;
  url: string;
}

// Matches https://github.com/{owner}/{repo}/pull/{number}.
export function parsePullRequestUrl(url: string): PullRequestReference | null {
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\/?$/u.exec(url);
  if (!match) return null;
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return { number, owner: match[1], repo: match[2] };
}

const personSchema = z
  .object({ avatar_url: z.string().nullish(), login: z.string() })
  .nullish()
  .transform((user): PullRequestPerson | null =>
    user ? { avatarUrl: user.avatar_url ?? null, login: user.login } : null,
  );

const pullSchema = z.object({
  additions: z.number().default(0),
  base: z.object({ ref: z.string() }),
  body: z.string().nullish(),
  changed_files: z.number().default(0),
  closed_at: z.string().nullish(),
  created_at: z.string(),
  deletions: z.number().default(0),
  draft: z.boolean().nullish(),
  head: z.object({ ref: z.string() }),
  html_url: z.string(),
  merged_at: z.string().nullish(),
  state: z.enum(["open", "closed"]),
  title: z.string(),
  user: personSchema,
});

const issueCommentSchema = z.object({
  body: z.string().nullish(),
  created_at: z.string(),
  html_url: z.string(),
  id: z.number(),
  user: personSchema,
});

const reviewSchema = z.object({
  body: z.string().nullish(),
  html_url: z.string(),
  id: z.number(),
  state: z.string(),
  submitted_at: z.string().nullish(),
  user: personSchema,
});

const reviewCommentSchema = z.object({
  body: z.string().nullish(),
  created_at: z.string(),
  html_url: z.string(),
  id: z.number(),
  line: z.number().nullish(),
  original_line: z.number().nullish(),
  path: z.string(),
  pull_request_review_id: z.number().nullish(),
});

const commitSchema = z.object({
  author: personSchema,
  commit: z.object({
    author: z.object({ date: z.string().nullish(), name: z.string().nullish() }).nullish(),
    message: z.string(),
  }),
  html_url: z.string(),
  sha: z.string(),
});

const fileSchema = z.object({
  additions: z.number().default(0),
  deletions: z.number().default(0),
  filename: z.string(),
  patch: z.string().nullish(),
  previous_filename: z.string().nullish(),
  status: z.enum(["added", "changed", "copied", "modified", "removed", "renamed", "unchanged"]).catch("modified"),
});

export class GitHubPullRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "GitHubPullRequestError";
  }
}

// A timeout reads as 504 and any other failure to reach GitHub as 502, so
// the routes can log a status for every failure.
function gitHubFailure(error: unknown): GitHubPullRequestError {
  if (error instanceof GitHubPullRequestError) return error;
  const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
  return new GitHubPullRequestError(timedOut ? "GitHub did not respond in time" : "Unable to reach GitHub", timedOut ? 504 : 502);
}

async function githubRequest(token: string, url: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    headers: { ...githubAppHeaders(token), ...init.headers },
    signal: AbortSignal.timeout(requestTimeoutMs),
  }).catch((error: unknown) => { throw gitHubFailure(error); });
  if (!response.ok) {
    throw new GitHubPullRequestError(`GitHub returned ${response.status}`, response.status);
  }
  return response;
}

function nextPageUrl(link: string | null): string | null {
  const next = link?.split(",").find((part) => /rel="next"/u.test(part));
  const url = next ? /<([^>]+)>/u.exec(next)?.[1] : undefined;
  return url?.startsWith(`${githubApiUrl}/`) ? url : null;
}

// Reads pages until GitHub has no next page or the limit is reached.
async function listAll<T>(
  token: string,
  path: string,
  schema: z.ZodType<T>,
  pages = maxPages,
): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  let url: string | null = `${githubApiUrl}${path}?per_page=100`;
  for (let page = 0; url && page < pages; page += 1) {
    const response = await githubRequest(token, url);
    items.push(...z.array(schema).parse(await response.json()));
    url = nextPageUrl(response.headers.get("link"));
  }
  return { items, truncated: url !== null };
}

function installationToken(installationId: number): Promise<string> {
  return createGitHubInstallationToken(installationId, AbortSignal.timeout(requestTimeoutMs))
    .catch((error: unknown) => { throw gitHubFailure(error); });
}

function pullRequestState(pull: { draft?: boolean | null; merged_at?: string | null; state: "open" | "closed" }): PullRequestState {
  if (pull.merged_at) return "merged";
  if (pull.state === "closed") return "closed";
  return pull.draft ? "draft" : "open";
}

const reviewStates = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
} as const;

// Issue comments and submitted reviews in the order they were posted. Each
// review carries the inline comments it submitted. A review that only replies
// to an inline thread has no body and appears through its comments.
export function pullRequestConversation(input: {
  issueComments: Array<z.infer<typeof issueCommentSchema>>;
  reviewComments: Array<z.infer<typeof reviewCommentSchema>>;
  reviews: Array<z.infer<typeof reviewSchema>>;
}): PullRequestConversationEntry[] {
  const inline = new Map<number, PullRequestInlineComment[]>();
  for (const comment of input.reviewComments) {
    if (comment.pull_request_review_id == null) continue;
    const comments = inline.get(comment.pull_request_review_id) ?? [];
    comments.push({
      body: comment.body ?? "",
      createdAt: comment.created_at,
      id: comment.id,
      line: comment.line ?? comment.original_line ?? null,
      path: comment.path,
      url: comment.html_url,
    });
    inline.set(comment.pull_request_review_id, comments);
  }
  const entries: PullRequestConversationEntry[] = [
    ...input.issueComments.map((comment) => ({
      author: comment.user,
      body: comment.body ?? "",
      createdAt: comment.created_at,
      id: comment.id,
      kind: "comment" as const,
      url: comment.html_url,
    })),
    ...input.reviews.flatMap((review) => {
      const state = reviewStates[review.state as keyof typeof reviewStates];
      const comments = inline.get(review.id) ?? [];
      const body = review.body?.trim() ?? "";
      if (!state || !review.submitted_at) return [];
      if (state === "commented" && !body && comments.length === 0) return [];
      return [{
        author: review.user,
        body,
        comments,
        createdAt: review.submitted_at,
        id: review.id,
        kind: "review" as const,
        state,
        url: review.html_url,
      }];
    }),
  ];
  return entries.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function fetchPullRequestDetail(
  installationId: number,
  reference: PullRequestReference,
): Promise<PullRequestDetail> {
  const token = await installationToken(installationId);
  const base = `/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.repo)}`;
  const [pull, issueComments, reviews, reviewComments, commits] = await Promise.all([
    githubRequest(token, `${githubApiUrl}${base}/pulls/${reference.number}`)
      .then(async (response) => pullSchema.parse(await response.json())),
    listAll(token, `${base}/issues/${reference.number}/comments`, issueCommentSchema),
    listAll(token, `${base}/pulls/${reference.number}/reviews`, reviewSchema),
    listAll(token, `${base}/pulls/${reference.number}/comments`, reviewCommentSchema),
    listAll(token, `${base}/pulls/${reference.number}/commits`, commitSchema),
  ]);
  return {
    additions: pull.additions,
    author: pull.user,
    baseBranch: pull.base.ref,
    body: pull.body ?? "",
    changedFiles: pull.changed_files,
    closedAt: pull.closed_at ?? null,
    commits: commits.items.map((commit) => ({
      author: commit.author,
      authorName: commit.commit.author?.name ?? null,
      committedAt: commit.commit.author?.date ?? null,
      message: commit.commit.message,
      sha: commit.sha,
      url: commit.html_url,
    })),
    conversation: pullRequestConversation({
      issueComments: issueComments.items,
      reviewComments: reviewComments.items,
      reviews: reviews.items,
    }),
    conversationTruncated: issueComments.truncated || reviews.truncated || reviewComments.truncated,
    createdAt: pull.created_at,
    deletions: pull.deletions,
    headBranch: pull.head.ref,
    mergedAt: pull.merged_at ?? null,
    state: pullRequestState(pull),
    title: pull.title,
    url: pull.html_url,
  };
}

export async function fetchPullRequestFiles(
  installationId: number,
  reference: PullRequestReference,
): Promise<PullRequestFile[]> {
  const token = await installationToken(installationId);
  const path = `/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.repo)}/pulls/${reference.number}/files`;
  const { items: files } = await listAll(token, path, fileSchema, maxFilePages);
  return files.map((file) => ({
    additions: file.additions,
    deletions: file.deletions,
    filename: file.filename,
    patch: file.patch ?? null,
    previousFilename: file.previous_filename ?? null,
    status: file.status,
  }));
}

const graphqlStateSchema = z.object({
  data: z.record(
    z.string(),
    z.object({
      pullRequest: z.object({ isDraft: z.boolean(), state: z.enum(["CLOSED", "MERGED", "OPEN"]) }).nullable(),
    }).nullable(),
  ).nullish(),
  errors: z.array(z.unknown()).nullish(),
});

// The state of each pull request, in one GraphQL request for an
// installation. A pull request GitHub does not return is left out.
export async function fetchPullRequestStates(
  installationId: number,
  references: PullRequestReference[],
): Promise<Array<PullRequestState | null>> {
  if (references.length === 0) return [];
  const token = await installationToken(installationId);
  const variables: Record<string, string | number> = {};
  const declarations: string[] = [];
  const fields = references.map((reference, index) => {
    variables[`owner${index}`] = reference.owner;
    variables[`name${index}`] = reference.repo;
    variables[`number${index}`] = reference.number;
    declarations.push(`$owner${index}: String!`, `$name${index}: String!`, `$number${index}: Int!`);
    return `pr${index}: repository(owner: $owner${index}, name: $name${index}) { pullRequest(number: $number${index}) { isDraft state } }`;
  });
  const response = await githubRequest(token, `${githubApiUrl}/graphql`, {
    body: JSON.stringify({ query: `query(${declarations.join(", ")}) { ${fields.join(" ")} }`, variables }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  // GraphQL reports failures in a 200 response. A pull request GitHub cannot
  // find comes back as an error next to the others' data.
  const result = graphqlStateSchema.parse(await response.json());
  if (!result.data) throw new GitHubPullRequestError("GitHub GraphQL returned no data", response.status);
  if (result.errors?.length) {
    console.warn(JSON.stringify({ errors: result.errors.length, event: "pull_request_states_partial", installationId }));
  }
  const data = result.data;
  return references.map((_, index) => {
    const pull = data[`pr${index}`]?.pullRequest;
    if (!pull) return null;
    if (pull.state === "MERGED") return "merged";
    if (pull.state === "CLOSED") return "closed";
    return pull.isDraft ? "draft" : "open";
  });
}
