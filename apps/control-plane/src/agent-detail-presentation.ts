import {
  type AgentConfiguration,
  type AgentDetail,
  type AgentOptions,
  slackChannelLabel,
} from "./agents-api";

export interface AgentPipelineCard {
  detail?: string;
  eyebrow: string;
  meta?: string;
  title: string;
}

export interface AgentPipelinePresentation {
  context: AgentPipelineCard;
  input: AgentPipelineCard;
  output: AgentPipelineCard;
}

const providerLabels: Record<AgentOptions["accounts"][number]["provider"], string> = {
  aws: "AWS",
  custom_mcp: "MCP",
  clickstack: "ClickStack / HyperDX",
  datadog: "Datadog",
  github: "GitHub",
  linear: "Linear",
  sentry: "Sentry",
  slack: "Slack",
  upstash: "Upstash",
  vercel: "Vercel",
};

function unique(values: string[]) {
  return [...new Set(values)];
}

function resourceName(
  options: AgentOptions,
  integrationAccountId: string,
  kind: AgentOptions["resources"][number]["kind"],
  externalId: string,
) {
  return options.resources.find(
    (resource) =>
      resource.integrationAccountId === integrationAccountId &&
      resource.kind === kind &&
      resource.externalId === externalId,
  )?.displayName;
}

function slackChannelName(
  options: AgentOptions,
  integrationAccountId: string,
  externalId: string,
) {
  return slackChannelLabel(
    resourceName(options, integrationAccountId, "slack_channel", externalId) ??
      externalId,
  );
}

function accountName(options: AgentOptions, integrationAccountId: string) {
  return options.accounts.find((account) => account.id === integrationAccountId)
    ?.displayName;
}

function summarizeInput(
  configuration: AgentConfiguration,
  options: AgentOptions,
): AgentPipelineCard {
  const { trigger } = configuration;
  const account = accountName(options, trigger.integrationAccountId);

  switch (trigger.kind) {
    case "slack_channel": {
      const channel = slackChannelName(
        options,
        trigger.integrationAccountId,
        trigger.channelId,
      );
      return {
        eyebrow: "Input · Slack",
        title: channel,
      };
    }
    case "slack_mention": {
      const channels = trigger.channelIds.map((channelId) =>
        slackChannelName(options, trigger.integrationAccountId, channelId),
      );
      return {
        detail: account ?? "Connected Slack workspace",
        eyebrow: "Input · Slack",
        title: channels.length ? channels.join(" · ") : "Any channel",
      };
    }
    case "sentry_issue": {
      const projects = trigger.projectIds.map(
        (projectId) =>
          resourceName(
            options,
            trigger.integrationAccountId,
            "sentry_project",
            projectId,
          ) ?? projectId,
      );
      return {
        detail: projects.length ? projects.join(" · ") : "All projects",
        eyebrow: "Input · Sentry",
        meta: account ?? "Connected Sentry organization",
        title: "New or regressed Sentry issue",
      };
    }
    case "datadog_monitor": {
      const monitors = trigger.monitorIds.map(
        (monitorId) =>
          resourceName(
            options,
            trigger.integrationAccountId,
            "datadog_monitor",
            monitorId,
          ) ?? monitorId,
      );
      return {
        detail: monitors.length ? monitors.join(" · ") : "All monitors",
        eyebrow: "Input · Datadog",
        meta: account ?? "Connected Datadog organization",
        title: "Every monitor alert",
      };
    }
  }
}

function summarizeContext(
  configuration: AgentConfiguration,
  repositories: AgentDetail["repositories"],
  options: AgentOptions,
): AgentPipelineCard {
  const providers = unique(
    configuration.contextAccountIds.flatMap((accountId) => {
      const account = options.accounts.find((candidate) => candidate.id === accountId);
      return account ? [providerLabels[account.provider]] : [];
    }),
  );
  const repositoryNames = repositories.map((repository) => repository.fullName);
  const secretNames = configuration.secretIds.flatMap((secretId) => {
    const secret = options.secrets.find((candidate) => candidate.id === secretId);
    return secret ? [secret.name] : [];
  });

  return {
    detail: `GitHub repositories: ${
      repositoryNames.length ? repositoryNames.join(" · ") : "None"
    }`,
    eyebrow: "Agent context",
    meta: [
      secretNames.length ? `Workspace secrets: ${secretNames.join(" · ")}` : null,
      configuration.createLinearTickets
        ? "Creates Linear tickets for new issues"
        : null,
    ]
      .filter(Boolean)
      .join(" · ") || undefined,
    title: providers.length ? providers.join(" · ") : "No additional providers",
  };
}

function pullRequestLabel(prMode: AgentConfiguration["prMode"]) {
  switch (prMode) {
    case "always":
      return "Opens pull requests automatically";
    case "manual":
      return "Pull requests on demand";
    case "disabled":
      return "Pull requests disabled";
  }
}

function severityLabel(
  reporting: Extract<
    AgentConfiguration["reporting"],
    { mode: "both" | "output_channel" }
  >,
) {
  return reporting.severities?.length
    ? reporting.severities.join(" · ")
    : "All severities";
}

function summarizeOutput(
  configuration: AgentConfiguration,
  options: AgentOptions,
): AgentPipelineCard {
  const { reporting } = configuration;
  if (reporting.mode === "thread") {
    return {
      eyebrow: "Output · Source",
      meta: pullRequestLabel(configuration.prMode),
      title: "Source thread",
    };
  }

  const channel = slackChannelName(
    options,
    reporting.integrationAccountId,
    reporting.outputChannelId,
  );
  return {
    detail: severityLabel(reporting),
    eyebrow: "Output · Slack",
    meta: pullRequestLabel(configuration.prMode),
    title: channel,
  };
}

export function buildAgentPipelinePresentation(
  configuration: AgentConfiguration,
  repositories: AgentDetail["repositories"],
  options: AgentOptions,
): AgentPipelinePresentation {
  return {
    context: summarizeContext(configuration, repositories, options),
    input: summarizeInput(configuration, options),
    output: summarizeOutput(configuration, options),
  };
}
