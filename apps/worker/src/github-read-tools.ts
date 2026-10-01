import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import type { RuntimeRepository } from "@responder/core/db/investigations";
import {
  createGitHubInstallationToken,
  githubAppHeaders,
} from "@responder/core/integrations/github";
import { z } from "zod";
import type { AutomationToolResult } from "./automation-tools.js";
import {
  importRuntimeRepositoryCommit,
  type CheckedOutRepository,
} from "./repositories.js";

// Read-only GitHub access for the agent. The worker makes each request with
// the GitHub App token, which never enters the sandbox, and only for the
// repositories the automation selected.

export const githubApiToolName = "github_api";
export const fetchRefToolName = "fetch_ref";

const githubApiOrigin = "https://api.github.com";
// Keeps a response within what a harness passes back to the model.
const maxResponseCharacters = 40_000;

export const githubReadToolDefinitions = [
  {
    annotations: { openWorldHint: true, readOnlyHint: true },
    description:
      "Read the GitHub REST API for a repository this automation can use, as the Responder GitHub App. Only GET requests under /repos/{owner}/{name}, and public user profiles at /users/{username}, are allowed. Examples: /repos/acme/app/pulls?state=open, /repos/acme/app/commits?sha=main&per_page=20, /repos/acme/app/compare/main...feature, /users/octocat. Follow the Link header for more pages.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        format: {
          description: "json (default), or diff for commits, compares, and pull requests.",
          enum: ["json", "diff"],
          type: "string",
        },
        path: {
          description: "The API path with its query string, starting with /repos/ or /users/.",
          maxLength: 2_000,
          minLength: 1,
          type: "string",
        },
      },
      required: ["path"],
      type: "object",
    },
    name: githubApiToolName,
  },
  {
    annotations: { openWorldHint: true, readOnlyHint: true },
    description:
      "Bring the files of a branch, tag, pull request head (pull/123/head), or commit of a checked-out repository into its checkout as the ref github/<ref>, without history. Then compare with git, for example: git diff HEAD github/main.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        ref: { maxLength: 200, minLength: 1, type: "string" },
        repository: {
          description: "The checked-out repository, as owner/name.",
          maxLength: 255,
          minLength: 1,
          type: "string",
        },
      },
      required: ["repository", "ref"],
      type: "object",
    },
    name: fetchRefToolName,
  },
];

const githubApiInput = z.object({
  format: z.enum(["json", "diff"]).default("json"),
  path: z.string().trim().min(1).max(2_000),
});
const fetchRefInput = z.object({
  ref: z.string().trim().min(1).max(200),
  repository: z.string().trim().min(1).max(255),
});

// Branch, tag, pull/123/head, or a commit; nothing git would read as an
// option or a range.
const refPattern = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)(?!.*\/$)[A-Za-z0-9._/-]+$/u;
const commitPattern = /^[a-f0-9]{40}$/iu;
// A GitHub username, or an app's bot account such as dependabot[bot].
const userPathPattern = /^\/users\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\]|%5Bbot%5D)?$/iu;

export interface GitHubReadToolDependencies {
  createInstallationToken: typeof createGitHubInstallationToken;
  fetch: typeof fetch;
  importCommit: typeof importRuntimeRepositoryCommit;
}

const defaultDependencies: GitHubReadToolDependencies = {
  createInstallationToken: createGitHubInstallationToken,
  fetch,
  importCommit: importRuntimeRepositoryCommit,
};

function text(value: string): AutomationToolResult {
  return { content: [{ text: value, type: "text" }] };
}

function failure(message: string): AutomationToolResult {
  return { content: [{ text: message, type: "text" }], isError: true };
}

const notSelected = failure("This repository is not selected for this automation.");

const truncationNote = "[Response truncated. Request a smaller page or a narrower path.]";
// A response is read only this far, so a download cannot fill the worker's
// memory before it is cut to what the agent sees.
const maxResponseBytes = 200_000;

async function limitedText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let bytes = 0;
  let cut = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    body += decoder.decode(value, { stream: true });
    if (bytes >= maxResponseBytes || body.length > maxResponseCharacters) {
      cut = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  if (!cut) body += decoder.decode();
  return body.length > maxResponseCharacters || cut
    ? `${body.slice(0, maxResponseCharacters)}\n${truncationNote}`
    : body;
}

export function createGitHubReadTools(input: {
  checkedOutRepositories: CheckedOutRepository[];
  repositories(): Promise<RuntimeRepository[]>;
  session: DaytonaSandboxSession;
}, dependencies: GitHubReadToolDependencies = defaultDependencies) {
  // Installation tokens last an hour, longer than a run's turn.
  const tokens = new Map<number, Promise<string>>();
  const token = (installationId: number) => {
    let pending = tokens.get(installationId);
    if (!pending) {
      pending = dependencies.createInstallationToken(installationId);
      pending.catch(() => tokens.delete(installationId));
      tokens.set(installationId, pending);
    }
    return pending;
  };
  const selected = async (fullName: string) =>
    (await input.repositories()).find(
      (repository) => repository.fullName.toLowerCase() === fullName.toLowerCase(),
    );

  async function get(repository: RuntimeRepository, url: URL, accept: string) {
    return dependencies.fetch(url, {
      headers: { ...githubAppHeaders(await token(repository.installationId)), accept },
      signal: AbortSignal.timeout(30_000),
    });
  }

  async function githubApi(args: unknown): Promise<AutomationToolResult> {
    const parsed = githubApiInput.safeParse(args);
    if (!parsed.success) return failure("Invalid tool arguments");
    let url: URL;
    try {
      url = new URL(parsed.data.path, githubApiOrigin);
    } catch {
      return failure("The path must be a GitHub API path such as /repos/owner/name/pulls.");
    }
    const [, scope, owner, name] = url.pathname.split("/");
    let repository: RuntimeRepository | undefined;
    if (url.origin === githubApiOrigin && scope === "users") {
      // A profile is public, so any selected repository's installation can
      // read it.
      if (!userPathPattern.test(url.pathname) || url.search) {
        return failure("Only a user profile at /users/{username} is allowed.");
      }
      repository = (await input.repositories())[0];
      if (!repository) return failure("This automation has no repositories selected.");
    } else {
      if (url.origin !== githubApiOrigin || scope !== "repos" || !owner || !name) {
        return failure("Only paths under /repos/{owner}/{name} or /users/{username} are allowed.");
      }
      if (owner.includes("%") || name.includes("%")) return notSelected;
      repository = await selected(`${owner}/${name}`);
      if (!repository) return notSelected;
    }

    let response: Response;
    let body: string;
    try {
      response = await get(
        repository,
        url,
        parsed.data.format === "diff" ? "application/vnd.github.diff" : "application/vnd.github+json",
      );
      body = await limitedText(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Request failed";
      return failure(`GitHub request failed: ${message.slice(0, 500)}`);
    }
    const link = response.headers.get("link");
    const result = [
      `HTTP ${response.status}`,
      ...(link ? [`Link: ${link}`] : []),
      "",
      body,
    ].join("\n");
    return response.ok ? text(result) : failure(result);
  }

  // Resolves a ref to its commit through the API.
  async function resolveCommit(repository: RuntimeRepository, ref: string): Promise<string> {
    if (commitPattern.test(ref)) return ref.toLowerCase();
    const pullRequest = /^pull\/(\d+)\/head$/u.exec(ref);
    const path = pullRequest
      ? `/repos/${repository.fullName}/pulls/${pullRequest[1]}`
      : `/repos/${repository.fullName}/commits/${ref.split("/").map(encodeURIComponent).join("/")}`;
    const response = await get(repository, new URL(path, githubApiOrigin), "application/vnd.github+json");
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`GitHub could not find ${ref} in ${repository.fullName} (HTTP ${response.status})`);
    }
    const payload = await response.json() as { head?: { sha?: unknown }; sha?: unknown };
    const sha = pullRequest ? payload.head?.sha : payload.sha;
    if (typeof sha !== "string" || !commitPattern.test(sha)) {
      throw new Error(`GitHub returned an invalid commit for ${ref}`);
    }
    return sha;
  }

  async function fetchRef(args: unknown): Promise<AutomationToolResult> {
    const parsed = fetchRefInput.safeParse(args);
    if (!parsed.success) return failure("Invalid tool arguments");
    const ref = parsed.data.ref.replace(/^refs\/(?:heads\/)?/u, "");
    if (!refPattern.test(ref)) return failure("The ref is not a valid branch, tag, pull request, or commit.");
    const repository = await selected(parsed.data.repository);
    const checkout = input.checkedOutRepositories.find(
      (candidate) => candidate.repository.toLowerCase() === parsed.data.repository.toLowerCase(),
    );
    if (!repository || !checkout) return notSelected;

    try {
      const sha = await resolveCommit(repository, ref);
      const name = commitPattern.test(ref) ? `commits/${sha}` : ref;
      await dependencies.importCommit(input.session, {
        checkout,
        localRef: `refs/remotes/github/${name}`,
        ref,
        repository,
        sha,
        token: await token(repository.installationId),
      });
      return text(JSON.stringify({
        note: `Files only, without history. Compare with: git diff HEAD github/${name}`,
        ref: `github/${name}`,
        repository: repository.fullName,
        sha,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to fetch the ref";
      return failure(`Unable to fetch ${ref}: ${message.slice(0, 500)}`);
    }
  }

  return { [fetchRefToolName]: fetchRef, [githubApiToolName]: githubApi };
}
