import { describe, expect, it } from "vitest";
import type { AgentOptions } from "./agents-api";
import { availableTagModeConfiguration } from "./tag-mode-configuration";

const options: AgentOptions = {
  accounts: [
    { id: "grafana", provider: "grafana", displayName: "Grafana" },
    { id: "vercel", provider: "vercel", displayName: "Vercel" },
  ],
  resources: [
    {
      id: "project",
      integrationAccountId: "vercel",
      kind: "vercel_project",
      externalId: "prj",
      displayName: "web",
    },
  ],
  repositories: [
    {
      id: "repository",
      integrationAccountId: "github",
      fullName: "acme/app",
      defaultBranch: "main",
      private: true,
    },
  ],
  secrets: [{ id: "secret", name: "TOKEN", allowedHosts: ["api.acme.test"] }],
};

describe("availableTagModeConfiguration", () => {
  it("drops references that the current options no longer offer", () => {
    const configuration = availableTagModeConfiguration(
      {
        enabled: true,
        model: "instance/default",
        instructions: "Investigate",
        contextAccountIds: ["removed-account", "grafana", "vercel"],
        contextResourceIds: ["project", "removed-project"],
        repositoryIds: ["removed-repository", "repository"],
        secretIds: ["secret", "removed-secret"],
      },
      options,
    );

    expect(configuration).toEqual({
      enabled: true,
      model: "instance/default",
      instructions: "Investigate",
      contextAccountIds: ["grafana", "vercel"],
      contextResourceIds: ["project"],
      repositoryIds: ["repository"],
      secretIds: ["secret"],
    });
  });
});
