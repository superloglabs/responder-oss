import { tool } from "@openai/agents";
import type { RuntimeRepository } from "@responder/core/db/investigations";
import {
  createGitHubInstallationToken,
  githubAppHeaders,
  type GitHubInstallationTokenOptions,
} from "@responder/core/integrations/github";
import { z } from "zod";

const MAX_RESPONSE_BYTES = 2_000_000;
const TOKEN_CACHE_MS = 50 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_TEXT_LENGTH = 20_000;

const actorSchema = z.object({ login: z.string() }).nullable();
const pullRequestRefSchema = z.object({
  ref: z.string(),
  sha: z.string(),
});
const pullRequestSchema = z.object({
  base: pullRequestRefSchema,
  body: z.string().nullable(),
  closed_at: z.string().nullable(),
  created_at: z.string(),
  draft: z.boolean(),
  head: pullRequestRefSchema,
  html_url: z.string().url(),
  merged_at: z.string().nullable(),
  number: z.number().int().positive(),
  state: z.string(),
  title: z.string(),
  updated_at: z.string(),
  user: actorSchema,
});
const pullRequestDetailsSchema = pullRequestSchema.extend({
  additions: z.number().int().nonnegative(),
  changed_files: z.number().int().nonnegative(),
  comments: z.number().int().nonnegative(),
  commits: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  merge_commit_sha: z.string().nullable(),
  review_comments: z.number().int().nonnegative(),
});
const pullRequestReviewSchema = z.object({
  body: z.string(),
  html_url: z.string().url(),
  id: z.number().int().positive(),
  state: z.string(),
  submitted_at: z.string().nullable(),
  user: actorSchema,
});
const issueCommentSchema = z.object({
  body: z.string(),
  created_at: z.string(),
  html_url: z.string().url(),
  id: z.number().int().positive(),
  updated_at: z.string(),
  user: actorSchema,
});
const reviewCommentSchema = issueCommentSchema.extend({
  diff_hunk: z.string(),
  line: z.number().int().nullable(),
  original_line: z.number().int().nullable(),
  path: z.string(),
});
const workflowRunSchema = z.object({
  conclusion: z.string().nullable(),
  created_at: z.string(),
  display_title: z.string(),
  event: z.string(),
  head_branch: z.string().nullable(),
  head_sha: z.string(),
  html_url: z.string().url(),
  id: z.number().int().positive(),
  name: z.string().nullable(),
  run_attempt: z.number().int().positive(),
  status: z.string().nullable(),
  updated_at: z.string(),
  workflow_id: z.number().int().positive(),
});
const workflowRunsSchema = z.object({
  total_count: z.number().int().nonnegative(),
  workflow_runs: z.array(workflowRunSchema),
});
const workflowJobSchema = z.object({
  completed_at: z.string().nullable(),
  conclusion: z.string().nullable(),
  html_url: z.string().url(),
  id: z.number().int().positive(),
  name: z.string(),
  runner_name: z.string().nullable(),
  started_at: z.string(),
  status: z.string(),
  steps: z.array(
    z.object({
      completed_at: z.string().nullable(),
      conclusion: z.string().nullable(),
      name: z.string(),
      number: z.number().int().positive(),
      started_at: z.string().nullable(),
      status: z.string(),
    }),
  ),
});
const workflowJobsSchema = z.object({
  jobs: z.array(workflowJobSchema),
  total_count: z.number().int().nonnegative(),
});
const checkRunSchema = z.object({
  app: z.object({ name: z.string(), slug: z.string().nullable() }).nullable(),
  completed_at: z.string().nullable(),
  conclusion: z.string().nullable(),
  details_url: z.string().url().nullable(),
  head_sha: z.string(),
  html_url: z.string().url().nullable(),
  id: z.number().int().positive(),
  name: z.string(),
  output: z.object({
    annotations_count: z.number().int().nonnegative(),
    summary: z.string().nullable(),
    text: z.string().nullable(),
    title: z.string().nullable(),
  }),
  started_at: z.string().nullable(),
  status: z.string(),
});
const checkRunsSchema = z.object({
  check_runs: z.array(checkRunSchema),
  total_count: z.number().int().nonnegative(),
});
const checkAnnotationSchema = z.object({
  annotation_level: z.string(),
  blob_href: z.string().url(),
  end_column: z.number().int().nullable(),
  end_line: z.number().int().positive(),
  message: z.string(),
  path: z.string(),
  raw_details: z.string().nullable(),
  start_column: z.number().int().nullable(),
  start_line: z.number().int().positive(),
  title: z.string().nullable(),
});

interface GitHubInspectionDependencies {
  createInstallationToken: (
    installationId: number,
    options?: GitHubInstallationTokenOptions,
  ) => Promise<string>;
  fetch: typeof fetch;
  now: () => number;
}

const defaultDependencies: GitHubInspectionDependencies = {
  createInstallationToken: createGitHubInstallationToken,
  fetch,
  now: Date.now,
};

function boundedText(value: string | null, limit = MAX_TEXT_LENGTH): string | null {
  if (value === null || value.length <= limit) return value;
  return `${value.slice(0, limit)}\n[truncated]`;
}

function repositoryName(fullName: string): string {
  const parts = fullName.split("/");
  if (
    parts.length !== 2 ||
    parts.some((part) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(part))
  ) {
    throw new Error(`Invalid GitHub repository name: ${fullName}`);
  }
  return parts[1]!;
}

function repositoryApiPath(fullName: string): string {
  repositoryName(fullName);
  return fullName.split("/").map(encodeURIComponent).join("/");
}

async function boundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("GitHub response was too large");
  }
  if (!response.body) return null;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let byteLength = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("GitHub response was too large");
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text ? JSON.parse(text) : null;
}

async function githubJson<T extends z.ZodType>(input: {
  fetchImpl: typeof fetch;
  path: string;
  schema: T;
  token: string;
  query?: URLSearchParams;
}): Promise<z.output<T>> {
  const url = new URL(`https://api.github.com${input.path}`);
  if (input.query) url.search = input.query.toString();
  const response = await input.fetchImpl(url, {
    headers: githubAppHeaders(input.token),
    method: "GET",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = await boundedJson(response).catch((error: unknown) => {
    if (error instanceof SyntaxError) {
      throw new Error("GitHub returned an invalid response");
    }
    throw error;
  });
  if (!response.ok) {
    const message =
      payload &&
        typeof payload === "object" &&
        "message" in payload &&
        typeof payload.message === "string"
        ? payload.message
        : `GitHub request failed (${response.status})`;
    throw new Error(message);
  }
  return input.schema.parse(payload);
}

function pullRequestSummary(pullRequest: z.infer<typeof pullRequestSchema>) {
  return {
    author: pullRequest.user?.login ?? null,
    base: pullRequest.base,
    closedAt: pullRequest.closed_at,
    createdAt: pullRequest.created_at,
    draft: pullRequest.draft,
    head: pullRequest.head,
    mergedAt: pullRequest.merged_at,
    number: pullRequest.number,
    state: pullRequest.state,
    title: pullRequest.title,
    updatedAt: pullRequest.updated_at,
    url: pullRequest.html_url,
  };
}

function workflowRunSummary(run: z.infer<typeof workflowRunSchema>) {
  return {
    conclusion: run.conclusion,
    createdAt: run.created_at,
    event: run.event,
    headBranch: run.head_branch,
    headSha: run.head_sha,
    id: run.id,
    name: run.name,
    runAttempt: run.run_attempt,
    status: run.status,
    title: run.display_title,
    updatedAt: run.updated_at,
    url: run.html_url,
    workflowId: run.workflow_id,
  };
}

function checkRunSummary(check: z.infer<typeof checkRunSchema>) {
  return {
    annotationsCount: check.output.annotations_count,
    app: check.app,
    completedAt: check.completed_at,
    conclusion: check.conclusion,
    detailsUrl: check.details_url,
    headSha: check.head_sha,
    id: check.id,
    name: check.name,
    output: {
      summary: boundedText(check.output.summary),
      text: boundedText(check.output.text),
      title: check.output.title,
    },
    startedAt: check.started_at,
    status: check.status,
    url: check.html_url,
  };
}

export function createGitHubInspectionTools(
  repositories: RuntimeRepository[],
  dependencies: Partial<GitHubInspectionDependencies> = {},
) {
  if (repositories.length === 0) return [];

  const deps = { ...defaultDependencies, ...dependencies };
  const repositoryNames = repositories.map(({ fullName }) => fullName);
  const repositoryParameter = z
    .string()
    .trim()
    .min(1)
    .describe(`One of: ${repositoryNames.join(", ")}`);
  const resultLimitParameter = z.number().int().min(1).max(100).default(30);
  const tokenCache = new Map<
    string,
    { createdAt: number; token: Promise<string> }
  >();

  function selectedRepository(fullName: string): RuntimeRepository {
    const repository = repositories.find(
      (candidate) => candidate.fullName === fullName,
    );
    if (!repository) {
      throw new Error("Repository is not attached to this Agent version");
    }
    return repository;
  }

  async function readToken(repository: RuntimeRepository): Promise<string> {
    const cached = tokenCache.get(repository.fullName);
    if (cached && deps.now() - cached.createdAt < TOKEN_CACHE_MS) {
      return cached.token;
    }
    const createdAt = deps.now();
    const token = deps.createInstallationToken(repository.installationId, {
      permissions: {
        actions: "read",
        checks: "read",
        contents: "read",
        metadata: "read",
        pull_requests: "read",
      },
      repositories: [repositoryName(repository.fullName)],
    });
    tokenCache.set(repository.fullName, { createdAt, token });
    try {
      return await token;
    } catch (error) {
      tokenCache.delete(repository.fullName);
      throw error;
    }
  }

  async function request<T extends z.ZodType>(
    repositoryFullName: string,
    path: string,
    schema: T,
    query?: URLSearchParams,
  ): Promise<z.output<T>> {
    const repository = selectedRepository(repositoryFullName);
    return githubJson({
      fetchImpl: deps.fetch,
      path: `/repos/${repositoryApiPath(repository.fullName)}${path}`,
      query,
      schema,
      token: await readToken(repository),
    });
  }

  const listPullRequests = tool({
    name: "github_list_pull_requests",
    description:
      "List recent pull requests and their merge state in an attached GitHub repository. Use this to inspect similar changes, regressions, and deployment history.",
    parameters: z.object({
      base: z.string().trim().min(1).max(255).optional(),
      limit: resultLimitParameter,
      repository: repositoryParameter,
      state: z.enum(["all", "closed", "open"]).default("all"),
    }),
    async execute(input) {
      const query = new URLSearchParams({
        direction: "desc",
        per_page: String(input.limit),
        sort: "updated",
        state: input.state,
      });
      if (input.base) query.set("base", input.base);
      const pullRequests = await request(
        input.repository,
        "/pulls",
        z.array(pullRequestSchema),
        query,
      );
      return pullRequests.map(pullRequestSummary);
    },
  });

  const getPullRequest = tool({
    name: "github_get_pull_request",
    description:
      "Read one pull request with bounded review and comment history from an attached GitHub repository.",
    parameters: z.object({
      discussionLimit: resultLimitParameter,
      pullRequestNumber: z.number().int().positive(),
      repository: repositoryParameter,
    }),
    async execute(input) {
      const path = `/pulls/${input.pullRequestNumber}`;
      const discussionQuery = new URLSearchParams({
        per_page: String(input.discussionLimit),
      });
      const [pullRequest, reviews, comments, reviewComments] = await Promise.all([
        request(input.repository, path, pullRequestDetailsSchema),
        request(
          input.repository,
          `${path}/reviews`,
          z.array(pullRequestReviewSchema),
          discussionQuery,
        ),
        request(
          input.repository,
          `/issues/${input.pullRequestNumber}/comments`,
          z.array(issueCommentSchema),
          discussionQuery,
        ),
        request(
          input.repository,
          `${path}/comments`,
          z.array(reviewCommentSchema),
          discussionQuery,
        ),
      ]);
      return {
        ...pullRequestSummary(pullRequest),
        additions: pullRequest.additions,
        body: boundedText(pullRequest.body),
        changedFiles: pullRequest.changed_files,
        commentCount: pullRequest.comments,
        commitCount: pullRequest.commits,
        deletions: pullRequest.deletions,
        mergeCommitSha: pullRequest.merge_commit_sha,
        reviewCommentCount: pullRequest.review_comments,
        reviews: reviews.map((review) => ({
          author: review.user?.login ?? null,
          body: boundedText(review.body),
          id: review.id,
          state: review.state,
          submittedAt: review.submitted_at,
          url: review.html_url,
        })),
        comments: comments.map((comment) => ({
          author: comment.user?.login ?? null,
          body: boundedText(comment.body),
          createdAt: comment.created_at,
          id: comment.id,
          updatedAt: comment.updated_at,
          url: comment.html_url,
        })),
        reviewComments: reviewComments.map((comment) => ({
          author: comment.user?.login ?? null,
          body: boundedText(comment.body),
          createdAt: comment.created_at,
          diffHunk: boundedText(comment.diff_hunk, 5_000),
          id: comment.id,
          line: comment.line,
          originalLine: comment.original_line,
          path: comment.path,
          updatedAt: comment.updated_at,
          url: comment.html_url,
        })),
      };
    },
  });

  const listWorkflowRuns = tool({
    name: "github_list_workflow_runs",
    description:
      "List recent GitHub Actions workflow runs in an attached repository, optionally filtered by branch, event, or status.",
    parameters: z.object({
      branch: z.string().trim().min(1).max(255).optional(),
      event: z.string().trim().min(1).max(100).optional(),
      limit: resultLimitParameter,
      repository: repositoryParameter,
      status: z.string().trim().min(1).max(100).optional(),
    }),
    async execute(input) {
      const query = new URLSearchParams({ per_page: String(input.limit) });
      if (input.branch) query.set("branch", input.branch);
      if (input.event) query.set("event", input.event);
      if (input.status) query.set("status", input.status);
      const result = await request(
        input.repository,
        "/actions/runs",
        workflowRunsSchema,
        query,
      );
      return {
        runs: result.workflow_runs.map(workflowRunSummary),
        totalCount: result.total_count,
      };
    },
  });

  const getWorkflowRun = tool({
    name: "github_get_workflow_run",
    description:
      "Read one GitHub Actions workflow run and its bounded job and step results. This does not return raw logs or artifacts.",
    parameters: z.object({
      jobLimit: resultLimitParameter,
      repository: repositoryParameter,
      runId: z.number().int().positive(),
    }),
    async execute(input) {
      const [run, jobs] = await Promise.all([
        request(
          input.repository,
          `/actions/runs/${input.runId}`,
          workflowRunSchema,
        ),
        request(
          input.repository,
          `/actions/runs/${input.runId}/jobs`,
          workflowJobsSchema,
          new URLSearchParams({ per_page: String(input.jobLimit) }),
        ),
      ]);
      return {
        ...workflowRunSummary(run),
        jobs: jobs.jobs.map((job) => ({
          completedAt: job.completed_at,
          conclusion: job.conclusion,
          id: job.id,
          name: job.name,
          runnerName: job.runner_name,
          startedAt: job.started_at,
          status: job.status,
          steps: job.steps.map((step) => ({
            completedAt: step.completed_at,
            conclusion: step.conclusion,
            name: step.name,
            number: step.number,
            startedAt: step.started_at,
            status: step.status,
          })),
          url: job.html_url,
        })),
        totalJobCount: jobs.total_count,
      };
    },
  });

  const listCheckRuns = tool({
    name: "github_list_check_runs",
    description:
      "List check runs for a commit SHA, branch, or tag in an attached GitHub repository, including bounded failure summaries.",
    parameters: z.object({
      checkName: z.string().trim().min(1).max(255).optional(),
      filter: z.enum(["all", "latest"]).default("latest"),
      limit: resultLimitParameter,
      ref: z.string().trim().min(1).max(255),
      repository: repositoryParameter,
      status: z.string().trim().min(1).max(100).optional(),
    }),
    async execute(input) {
      const query = new URLSearchParams({
        filter: input.filter,
        per_page: String(input.limit),
      });
      if (input.checkName) query.set("check_name", input.checkName);
      if (input.status) query.set("status", input.status);
      const result = await request(
        input.repository,
        `/commits/${encodeURIComponent(input.ref)}/check-runs`,
        checkRunsSchema,
        query,
      );
      return {
        checkRuns: result.check_runs.map(checkRunSummary),
        totalCount: result.total_count,
      };
    },
  });

  const getCheckRun = tool({
    name: "github_get_check_run",
    description:
      "Read one GitHub check run and its bounded annotations from an attached repository.",
    parameters: z.object({
      annotationLimit: resultLimitParameter,
      checkRunId: z.number().int().positive(),
      repository: repositoryParameter,
    }),
    async execute(input) {
      const [checkRun, annotations] = await Promise.all([
        request(
          input.repository,
          `/check-runs/${input.checkRunId}`,
          checkRunSchema,
        ),
        request(
          input.repository,
          `/check-runs/${input.checkRunId}/annotations`,
          z.array(checkAnnotationSchema),
          new URLSearchParams({ per_page: String(input.annotationLimit) }),
        ),
      ]);
      return {
        ...checkRunSummary(checkRun),
        annotations: annotations.map((annotation) => ({
          endColumn: annotation.end_column,
          endLine: annotation.end_line,
          level: annotation.annotation_level,
          message: boundedText(annotation.message),
          path: annotation.path,
          rawDetails: boundedText(annotation.raw_details),
          startColumn: annotation.start_column,
          startLine: annotation.start_line,
          title: annotation.title,
          url: annotation.blob_href,
        })),
      };
    },
  });

  return [
    listPullRequests,
    getPullRequest,
    listWorkflowRuns,
    getWorkflowRun,
    listCheckRuns,
    getCheckRun,
  ];
}
