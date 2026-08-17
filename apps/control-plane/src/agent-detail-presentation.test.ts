import { describe, expect, it } from "vitest";
import {
  type AgentConfiguration,
  type AgentOptions,
} from "./agents-api";
import { buildAgentPipelinePresentation } from "./agent-detail-presentation";

const options: AgentOptions = {
  accounts: [
    { id: "slack", provider: "slack", displayName: "Acme Inc." },
    { id: "sentry", provider: "sentry", displayName: "Acme Sentry" },
    { id: "datadog", provider: "datadog", displayName: "Acme Datadog" },
  ],
  repositories: [],
  secrets: [
    {
      id: "service-key",
      name: "SERVICE_API_KEY",
      allowedHosts: ["api.example.com"],
    },
  ],
  resources: [
    {
      id: "input-channel",
      integrationAccountId: "slack",
      kind: "slack_channel",
      externalId: "C_INPUT",
      displayName: "prod-alerts",
    },
    {
      id: "output-channel",
      integrationAccountId: "slack",
      kind: "slack_channel",
      externalId: "C_OUTPUT",
      displayName: "#incident-response",
    },
  ],
};

const configuration: AgentConfiguration = {
  contextAccountIds: ["sentry", "datadog"],
  contextResourceIds: [],
  secretIds: ["service-key"],
  createLinearTickets: false,
  linearIssueTemplate: "{{description}}",
  description: "Investigates production alerts.",
  enabled: true,
  instructions: "Investigate the issue.",
  model: "instance/default",
  name: "Production responder",
  prMode: "manual",
  reporting: {
    integrationAccountId: "slack",
    mode: "output_channel",
    outputChannelId: "C_OUTPUT",
    severities: ["SEV-1", "SEV-2", "SEV-3"],
  },
  repositoryIds: ["api", "web"],
  trigger: {
    channelId: "C_INPUT",
    integrationAccountId: "slack",
    kind: "slack_channel",
  },
};

describe("buildAgentPipelinePresentation", () => {
  it("resolves channels, context providers, repositories, and output behavior", () => {
    const presentation = buildAgentPipelinePresentation(
      configuration,
      [
        {
          defaultBranch: "main",
          fullName: "acme/api",
          id: "api",
          integrationAccountId: "github",
          private: true,
        },
        {
          defaultBranch: "main",
          fullName: "acme/web",
          id: "web",
          integrationAccountId: "github",
          private: true,
        },
      ],
      options,
    );

    expect(presentation.input).toEqual({
      eyebrow: "Input · Slack",
      title: "#prod-alerts",
    });
    expect(presentation.context.title).toBe("Sentry · Datadog");
    expect(presentation.context.detail).toBe(
      "GitHub repositories: acme/api · acme/web",
    );
    expect(presentation.context.meta).toBe(
      "Workspace secrets: SERVICE_API_KEY",
    );
    expect(presentation.output).toEqual({
      detail: "SEV-1 · SEV-2 · SEV-3",
      eyebrow: "Output · Slack",
      meta: "Pull requests on demand",
      title: "#incident-response",
    });
  });

  it("describes mention triggers and source-thread reporting without resources", () => {
    const presentation = buildAgentPipelinePresentation(
      {
        ...configuration,
        contextAccountIds: [],
        contextResourceIds: [],
        secretIds: [],
        prMode: "disabled",
        reporting: { mode: "thread" },
        repositoryIds: [],
        trigger: {
          channelIds: [],
          integrationAccountId: "slack",
          kind: "slack_mention",
        },
      },
      [],
      { accounts: options.accounts, repositories: [], resources: [], secrets: [] },
    );

    expect(presentation.input.title).toBe("Any channel");
    expect(presentation.context.detail).toBe("GitHub repositories: None");
    expect(presentation.output.title).toBe("Source thread");
    expect(presentation.output.meta).toBe("Pull requests disabled");
  });
});
