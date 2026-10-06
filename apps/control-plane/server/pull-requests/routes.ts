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
      console.warn(JSON.stringify({
        event: "pull_request_states_failed",
        installationId,
        status: error instanceof Error && "status" in error ? error.status : null,
      }));
    }
  }));
  return states;
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
    const pullRequestId = context.req.param("pullRequestId");
    if (!z.string().uuid().safeParse(pullRequestId).success) {
      return context.json({ error: "Pull request not found" }, 404);
    }
    const pullRequest = await getAutomationPullRequest(access.organizationId, pullRequestId);
    if (!pullRequest) return context.json({ error: "Pull request not found" }, 404);
    const reference = parsePullRequestUrl(pullRequest.url);
    const summary = { ...pullRequest, number: reference?.number ?? null };
    if (!reference) {
      return context.json({ github: null, githubError: "This pull request link is not a GitHub pull request.", pullRequest: summary });
    }
    const installationId = (
      await getGitHubRepositoryInstallations(access.organizationId, [repositoryKey(reference)])
    ).get(repositoryKey(reference));
    if (!installationId) {
      return context.json({ github: null, githubError: "Responder no longer has access to this repository. Reconnect GitHub to see the pull request here.", pullRequest: summary });
    }
    try {
      return context.json({ github: await fetchPullRequestDetail(installationId, reference), githubError: null, pullRequest: summary });
    } catch (error) {
      console.warn(JSON.stringify({
        event: "pull_request_detail_failed",
        installationId,
        status: error instanceof Error && "status" in error ? error.status : null,
      }));
      return context.json({ github: null, githubError: "Unable to load the pull request from GitHub. Try again.", pullRequest: summary });
    }
  });
