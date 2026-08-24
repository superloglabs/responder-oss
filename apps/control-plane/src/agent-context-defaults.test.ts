import { describe, expect, it } from "vitest";
import type { AgentOptions } from "./agents-api";
import { defaultAgentContext } from "./agent-context-defaults";

const OPTIONS: AgentOptions = {
  accounts: [
    { id: "sentry-1", provider: "sentry", displayName: "Production" },
    { id: "axiom-1", provider: "axiom", displayName: "Production" },
    { id: "aws-1", provider: "aws", displayName: "Production" },
    { id: "aws-2", provider: "aws", displayName: "Staging" },
    {
      id: "slack-1",
      provider: "slack",
      displayName: "Acme",
      slackContextAvailable: true,
    },
    { id: "github-1", provider: "github", displayName: "Acme" },
    { id: "vercel-1", provider: "vercel", displayName: "Acme" },
  ],
  resources: [
    {
      id: "slack-channel-1",
      integrationAccountId: "slack-1",
      kind: "slack_channel",
      externalId: "C1",
      displayName: "incidents",
    },
    {
      id: "slack-channel-2",
      integrationAccountId: "slack-1",
      kind: "slack_channel",
      externalId: "C2",
      displayName: "platform",
    },
    {
      id: "vercel-project-1",
      integrationAccountId: "vercel-1",
      kind: "vercel_project",
      externalId: "project-1",
      displayName: "dashboard",
    },
  ],
  repositories: [
    {
      id: "repository-1",
      integrationAccountId: "github-1",
      fullName: "acme/responder",
      defaultBranch: "main",
      private: true,
    },
  ],
  secrets: [],
};

describe("defaultAgentContext", () => {
  it("enables every direct connection and a safe initial scope for resource providers", () => {
    expect(defaultAgentContext(OPTIONS)).toEqual({
      contextAccountIds: ["sentry-1", "axiom-1", "aws-1", "aws-2", "vercel-1"],
      contextResourceIds: ["slack-channel-1", "vercel-project-1"],
      repositoryIds: ["repository-1"],
    });
  });

  it("does not invent selections when connected resources are unavailable", () => {
    expect(
      defaultAgentContext({
        accounts: OPTIONS.accounts.filter(
          (account) => account.provider === "slack" || account.provider === "github",
        ),
        resources: [],
        repositories: [],
        secrets: [],
      }),
    ).toEqual({
      contextAccountIds: [],
      contextResourceIds: [],
      repositoryIds: [],
    });
  });

  it("reserves an account slot for a default Vercel project", () => {
    const directAccounts: AgentOptions["accounts"] = Array.from(
      { length: 20 },
      (_, index) => ({
        id: `aws-${index + 1}`,
        provider: "aws",
        displayName: `AWS ${index + 1}`,
      }),
    );
    const defaults = defaultAgentContext({
      accounts: [
        ...directAccounts,
        { id: "vercel-1", provider: "vercel", displayName: "Acme" },
      ],
      resources: [
        {
          id: "vercel-project-1",
          integrationAccountId: "vercel-1",
          kind: "vercel_project",
          externalId: "project-1",
          displayName: "dashboard",
        },
      ],
      repositories: [],
      secrets: [],
    });

    expect(defaults.contextAccountIds).toHaveLength(20);
    expect(defaults.contextAccountIds).toContain("vercel-1");
    expect(defaults.contextResourceIds).toEqual(["vercel-project-1"]);
  });
});
