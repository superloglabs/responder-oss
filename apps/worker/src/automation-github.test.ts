import { describe, expect, it } from "vitest";
import { githubPullRequestOf, githubTriggerInstructions } from "./automation-github.js";

const triggerInput = {
  attributes: {
    author: "octocat",
    event: "merged",
    integrationAccountId: "1d2c3b4a-5f6e-4d7c-8b9a-0f1e2d3c4b5a",
    pullRequestNumber: 42,
    repository: "acme/api",
    repositoryId: "8c7d1f9e-2a4b-4c3d-9e8f-1a2b3c4d5e6f",
  },
  body: "{}",
  provider: "github",
  title: "acme/api#42: Retry webhook deliveries",
};

describe("GitHub-triggered automation runs", () => {
  it("reads the pull request that started the run", () => {
    expect(githubPullRequestOf(triggerInput)).toEqual({
      event: "merged",
      pullRequestNumber: 42,
      repository: "acme/api",
      repositoryId: "8c7d1f9e-2a4b-4c3d-9e8f-1a2b3c4d5e6f",
    });
    expect(githubPullRequestOf({ ...triggerInput, provider: "devrev" })).toBeNull();
  });

  it("tells the agent how to read the pull request", () => {
    const [instructions] = githubTriggerInstructions(triggerInput);
    expect(instructions).toContain("pull request #42 in acme/api was merged");
    expect(instructions).toContain("github_api at /repos/acme/api/pulls/42");
    expect(githubTriggerInstructions({ provider: "schedule" })).toEqual([]);
  });
});
