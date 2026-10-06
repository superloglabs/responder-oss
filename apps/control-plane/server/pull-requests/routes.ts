import { Hono } from "hono";
import { z } from "zod";
import {
  getAutomationPullRequest,
  getGitHubRepositoryInstallations,
  listAutomationPullRequests,
} from "../../../../packages/core/src/db/automations.js";
import { organizationHasCapability } from "../../../../packages/core/src/db/organization-capabilities.js";
import { getActiveTenant } from "../tenant.js";
import {
  fetchPullRequestDetail,
  fetchPullRequestFiles,
  fetchPullRequestStates,
  parsePullRequestUrl,
  type PullRequestReference,
  type PullRequestState,
} from "./github.js";

const pageSize = 25;
const pageSchema = z.coerce.number().int().min(1).max(10_000).catch(1);

// Pull requests come from automation runs, so the list follows the
// automations capability.
async function getPullRequestTenant(headers: Headers): Promise<
  | { ok: true; organizationId: string }
  | { ok: false; error: string; status: 401 | 403 | 404 | 409 }
> {
  const tenant = await getActiveTenant(headers);
  if (tenant.ok === false) return tenant;
  if (!(await organizationHasCapability(tenant.organizationId, "automations"))) {
    return { ok: false, error: "Not found", status: 404 };
  }
  return { ok: true, organizationId: tenant.organizationId };
}

function repositoryKey(reference: PullRequestReference): string {
  return `${reference.owner}/${reference.repo}`.toLowerCase();
}

// Reads the states from GitHub, grouped by installation. A state GitHub
// cannot return is null, and the list still loads.
async function pullRequestStates(
  organizationId: string,
  urls: string[],
): Promise<Array<PullRequestState | null>> {
  const references = urls.map(parsePullRequestUrl);
  const installations = await getGitHubRepositoryInstallations(
    organizationId,
    references.flatMap((reference) => reference ? [repositoryKey(reference)] : []),
  );
  const groups = new Map<number, number[]>();
  references.forEach((reference, index) => {
    const installationId = reference && installations.get(repositoryKey(reference));
    if (!installationId) return;
    groups.set(installationId, [...groups.get(installationId) ?? [], index]);
  });
  const states: Array<PullRequestState | null> = urls.map(() => null);
  await Promise.all([...groups].map(async ([installationId, indexes]) => {
    try {
      const loaded = await fetchPullRequestStates(installationId, indexes.map((index) => references[index]!));
      indexes.forEach((index, position) => { states[index] = loaded[position] ?? null; });
    } catch (error) {
      logGitHubFailure("pull_request_states_failed", installationId, error);
    }
  }));
  return states;
}

function logGitHubFailure(event: string, installationId: number, error: unknown) {
  console.warn(JSON.stringify({
    event,
    installationId,
    status: error instanceof Error && "status" in error ? error.status : null,
  }));
}

// The organization's pull request and the installation that can read it.
// Null when the organization has no such pull request.
async function resolvePullRequest(organizationId: string, pullRequestId: string) {
  if (!z.string().uuid().safeParse(pullRequestId).success) return null;
  const pullRequest = await getAutomationPullRequest(organizationId, pullRequestId);
  if (!pullRequest) return null;
  const reference = parsePullRequestUrl(pullRequest.url);
  const summary = { ...pullRequest, number: reference?.number ?? null };
  if (!reference) {
    return { githubError: "This pull request link is not a GitHub pull request.", ok: false as const, summary };
  }
  const installationId = (
    await getGitHubRepositoryInstallations(organizationId, [repositoryKey(reference)])
  ).get(repositoryKey(reference));
  if (!installationId) {
    return { githubError: "Responder no longer has access to this repository. Reconnect GitHub to see the pull request here.", ok: false as const, summary };
  }
  return { installationId, ok: true as const, reference, summary };
}

export const pullRequestRoutes = new Hono()
  .get("/", async (context) => {
    const access = await getPullRequestTenant(context.req.raw.headers);
    if (!access.ok) return context.json({ error: access.error }, access.status);
    const page = pageSchema.parse(context.req.query("page"));
    const result = await listAutomationPullRequests(access.organizationId, {
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    const states = await pullRequestStates(
      access.organizationId,
      result.pullRequests.map((pullRequest) => pullRequest.url),
    );
    return context.json({
      page,
      pageSize,
      pullRequests: result.pullRequests.map((pullRequest, index) => ({
        ...pullRequest,
        number: parsePullRequestUrl(pullRequest.url)?.number ?? null,
        state: states[index],
      })),
      total: result.total,
    });
  })
  .get("/:pullRequestId", async (context) => {
    const access = await getPullRequestTenant(context.req.raw.headers);
    if (!access.ok) return context.json({ error: access.error }, access.status);
    const resolved = await resolvePullRequest(access.organizationId, context.req.param("pullRequestId"));
    if (!resolved) return context.json({ error: "Pull request not found" }, 404);
    if (!resolved.ok) return context.json({ github: null, githubError: resolved.githubError, pullRequest: resolved.summary });
    try {
      return context.json({ github: await fetchPullRequestDetail(resolved.installationId, resolved.reference), githubError: null, pullRequest: resolved.summary });
    } catch (error) {
      logGitHubFailure("pull_request_detail_failed", resolved.installationId, error);
      return context.json({ github: null, githubError: "Unable to load the pull request from GitHub. Try again.", pullRequest: resolved.summary });
    }
  })
  .get("/:pullRequestId/files", async (context) => {
    const access = await getPullRequestTenant(context.req.raw.headers);
    if (!access.ok) return context.json({ error: access.error }, access.status);
    const resolved = await resolvePullRequest(access.organizationId, context.req.param("pullRequestId"));
    if (!resolved) return context.json({ error: "Pull request not found" }, 404);
    if (!resolved.ok) return context.json({ files: null, githubError: resolved.githubError });
    try {
      return context.json({ files: await fetchPullRequestFiles(resolved.installationId, resolved.reference), githubError: null });
    } catch (error) {
      logGitHubFailure("pull_request_files_failed", resolved.installationId, error);
      return context.json({ files: null, githubError: "Unable to load the changed files from GitHub. Try again." });
    }
  });
