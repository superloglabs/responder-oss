import { describe, expect, it, vi } from "vitest";
import { startPullRequestAutomations } from "./github-pull-request-automations.js";

vi.mock("@responder/core/db/automations", () => ({
  findAutomationsForGitHubPullRequest: vi.fn(),
}));

vi.mock("../automations/queue.js", () => ({
  queueAutomationRun: vi.fn(),
}));

const repositoryId = "8c7d1f9e-2a4b-4c3d-9e8f-1a2b3c4d5e6f";
const integrationAccountId = "1d2c3b4a-5f6e-4d7c-8b9a-0f1e2d3c4b5a";

function event(overrides: {
  action?: string;
  authorAssociation?: string;
  draft?: boolean;
  login?: string;
  merged?: boolean;
  private?: boolean;
} = {}) {
  return {
    action: overrides.action ?? "opened",
    installation: { id: 789 },
    pull_request: {
      additions: 12,
      author_association: overrides.authorAssociation ?? "MEMBER",
      base: { ref: "main" },
      body: "Adds retries to the webhook client.",
      changed_files: 2,
      deletions: 3,
      draft: overrides.draft ?? false,
      head: { ref: "feature/retries", sha: "a".repeat(40) },
      html_url: "https://github.com/acme/api/pull/42",
      labels: [{ name: "backend" }],
      merge_commit_sha: overrides.merged ? "b".repeat(40) : null,
      merged: overrides.merged ?? false,
      merged_by: overrides.merged ? { login: "maintainer" } : null,
      number: 42,
      title: "Retry webhook deliveries",
      user: { login: overrides.login ?? "octocat", type: "User" },
    },
    repository: { full_name: "acme/api", id: 555, private: overrides.private ?? true },
  };
}

function dependencies(matches = [{ automationId: "automation-1", integrationAccountId, repositoryId }]) {
  return {
    findAutomations: vi.fn().mockResolvedValue(matches),
    queueAutomationRun: vi.fn().mockResolvedValue({ duplicate: false, runId: "run-1" }),
  };
}

const appEnvironment = { GITHUB_APP_SLUG: "superlog-responder" };

describe("GitHub pull request automations", () => {

  it("starts each matching automation when a pull request is opened", async () => {
    const deps = dependencies([
      { automationId: "automation-1", integrationAccountId, repositoryId },
      { automationId: "automation-2", integrationAccountId, repositoryId },
    ]);

    const outcome = await startPullRequestAutomations(event(), deps, appEnvironment);

    expect(outcome).toEqual({ matchedAutomations: 2, outcome: "matched" });
    expect(deps.queueAutomationRun.mock.calls.map(([input]) => input.automationId))
      .toEqual(["automation-1", "automation-2"]);
    expect(deps.findAutomations).toHaveBeenCalledWith({
      event: "opened",
      installationId: "789",
      repositoryExternalId: "555",
    });
    const trigger = deps.queueAutomationRun.mock.calls[0]![0].trigger;
    expect(deps.queueAutomationRun.mock.calls[0]![0].automationId).toBe("automation-1");
    expect(trigger).toMatchObject({
      attributes: {
        author: "octocat",
        event: "opened",
        integrationAccountId,
        pullRequestNumber: 42,
        repository: "acme/api",
        repositoryId,
      },
      externalEventId: "789:555:42:opened",
      provider: "github",
      sourceUrl: "https://github.com/acme/api/pull/42",
      title: "acme/api#42: Retry webhook deliveries",
    });
    expect(JSON.parse(trigger.body)).toMatchObject({
      author: "octocat",
      base: "main",
      body: "Adds retries to the webhook client.",
      head: "feature/retries",
      labels: ["backend"],
      number: 42,
    });
  });

  it("starts merged automations when a pull request is merged", async () => {
    const deps = dependencies();

    await startPullRequestAutomations(event({ action: "closed", merged: true }), deps, appEnvironment);

    expect(deps.findAutomations).toHaveBeenCalledWith(expect.objectContaining({ event: "merged" }));
    const trigger = deps.queueAutomationRun.mock.calls[0]![0].trigger;
    expect(trigger.externalEventId).toBe("789:555:42:merged");
    expect(JSON.parse(trigger.body)).toMatchObject({
      mergeCommitSha: "b".repeat(40),
      mergedBy: "maintainer",
    });
  });

  it("treats a draft as opened when it is marked ready for review", async () => {
    const draft = dependencies();
    await expect(startPullRequestAutomations(event({ draft: true }), draft, appEnvironment))
      .resolves.toEqual({ outcome: "ignored" });
    expect(draft.findAutomations).not.toHaveBeenCalled();

    const ready = dependencies();
    await startPullRequestAutomations(event({ action: "ready_for_review" }), ready, appEnvironment);
    expect(ready.findAutomations).toHaveBeenCalledWith(expect.objectContaining({ event: "opened" }));
    expect(ready.queueAutomationRun.mock.calls[0]![0].trigger.externalEventId).toBe("789:555:42:opened");
  });

  it("ignores pull requests closed without merging and other actions", async () => {
    for (const payload of [
      event({ action: "closed", merged: false }),
      event({ action: "synchronize" }),
      event({ action: "edited" }),
    ]) {
      const deps = dependencies();
      await expect(startPullRequestAutomations(payload, deps, appEnvironment)).resolves.toEqual({ outcome: "ignored" });
      expect(deps.findAutomations).not.toHaveBeenCalled();
    }
  });

  it("does not start runs for pull requests Responder opens", async () => {
    const deps = dependencies();

    const outcome = await startPullRequestAutomations(
      event({ login: "superlog-responder[bot]" }),
      deps,
      appEnvironment,
    );

    expect(outcome).toEqual({ outcome: "ignored" });
    expect(deps.queueAutomationRun).not.toHaveBeenCalled();
  });

  it("starts runs when Responder's pull request is merged", async () => {
    const deps = dependencies();

    await startPullRequestAutomations(
      event({ action: "closed", login: "superlog-responder[bot]", merged: true }),
      deps,
      appEnvironment,
    );

    expect(deps.queueAutomationRun).toHaveBeenCalledTimes(1);
  });

  it("ignores pull requests on a public repository from authors who are not owners, members, or collaborators", async () => {
    const merged = dependencies();
    await expect(startPullRequestAutomations(
      event({ action: "closed", authorAssociation: "CONTRIBUTOR", merged: true, private: false }),
      merged,
      appEnvironment,
    )).resolves.toEqual({ outcome: "ignored" });
    expect(merged.findAutomations).not.toHaveBeenCalled();

    const outsider = dependencies();
    await expect(startPullRequestAutomations(
      event({ authorAssociation: "CONTRIBUTOR", private: false }),
      outsider,
      appEnvironment,
    )).resolves.toEqual({ outcome: "ignored" });
    expect(outsider.findAutomations).not.toHaveBeenCalled();

    const collaborator = dependencies();
    await startPullRequestAutomations(event({ authorAssociation: "COLLABORATOR", private: false }), collaborator, appEnvironment);
    expect(collaborator.queueAutomationRun).toHaveBeenCalledTimes(1);

    const privateRepository = dependencies();
    await startPullRequestAutomations(event({ authorAssociation: "CONTRIBUTOR", private: true }), privateRepository, appEnvironment);
    expect(privateRepository.queueAutomationRun).toHaveBeenCalledTimes(1);
  });

  it("ignores a malformed payload", async () => {
    const deps = dependencies();

    await expect(startPullRequestAutomations({ action: "opened" }, deps, appEnvironment))
      .resolves.toEqual({ outcome: "ignored" });
    expect(deps.findAutomations).not.toHaveBeenCalled();
  });

  it("reports when a run cannot be queued", async () => {
    const deps = dependencies();
    deps.queueAutomationRun.mockRejectedValue(new Error("Automation worker is unavailable"));

    await expect(startPullRequestAutomations(event(), deps, appEnvironment)).rejects.toThrow("Automation worker is unavailable");
  });

  it("does not start runs for opened pull requests without the app's slug", async () => {
    const deps = dependencies();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(startPullRequestAutomations(event(), deps, {})).resolves.toEqual({ outcome: "ignored" });
    expect(deps.findAutomations).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("keeps the trigger body valid JSON when the pull request is large", async () => {
    const deps = dependencies();
    const payload = event();
    payload.pull_request.body = `${"x".repeat(59_999)}😀${"y".repeat(10_000)}`;
    payload.pull_request.labels = Array.from({ length: 100 }, (_, index) => ({ name: `${"label".repeat(9)}${index}` }));

    await startPullRequestAutomations(payload, deps, appEnvironment);

    const body = JSON.parse(deps.queueAutomationRun.mock.calls[0]![0].trigger.body) as { body: string };
    expect(body.body).toHaveLength(59_999);
    expect(body.body.endsWith("x")).toBe(true);
  });
});
