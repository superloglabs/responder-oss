import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  type AgentConfiguration,
  type AgentOptions,
  type AgentTrigger,
  type TriggerKind,
  fetchAgent,
  fetchAgentOptions,
  saveAgent,
  slackChannelLabel,
} from "../agents-api";
import { AppShell } from "../components/app-shell";
import {
  ChevronDownIcon,
  RepositoryIcon,
} from "../components/icons";
import { useDocumentTitle } from "../use-document-title";

const EMPTY_OPTIONS: AgentOptions = {
  accounts: [],
  resources: [],
  repositories: [],
  secrets: [],
};

const TRIGGERS: Array<{
  kind: TriggerKind;
  title: string;
  description: string;
}> = [
  {
    kind: "sentry_issue",
    title: "New or regressed Sentry issue",
    description:
      "Investigate issues created or regressed in selected projects.",
  },
  {
    kind: "datadog_monitor",
    title: "Datadog monitor",
    description: "Investigate alerts from selected monitors.",
  },
  {
    kind: "slack_channel",
    title: "Slack channel",
    description: "Monitor one channel for incoming incident alerts.",
  },
  {
    kind: "slack_mention",
    title: "@Responder mention",
    description: "Start when Responder is mentioned in Slack.",
  },
];

function resourcesForTrigger(options: AgentOptions, kind: TriggerKind) {
  const resourceKind =
    kind === "sentry_issue"
      ? "sentry_project"
      : kind === "datadog_monitor"
        ? "datadog_monitor"
        : "slack_channel";
  return options.resources.filter((resource) => resource.kind === resourceKind);
}

function createTrigger(
  options: AgentOptions,
  kind: TriggerKind,
): AgentTrigger | null {
  const resources = resourcesForTrigger(options, kind);
  const resource = resources[0];
  if (!resource) return null;

  switch (kind) {
    case "sentry_issue":
      return {
        kind,
        integrationAccountId: resource.integrationAccountId,
        projectIds: [resource.externalId],
      };
    case "datadog_monitor":
      return {
        kind,
        integrationAccountId: resource.integrationAccountId,
        monitorIds: [resource.externalId],
      };
    case "slack_channel":
      return {
        kind,
        integrationAccountId: resource.integrationAccountId,
        channelId: resource.externalId,
      };
    case "slack_mention":
      return {
        kind,
        integrationAccountId: resource.integrationAccountId,
        channelIds: [],
      };
  }
}

function createDefaultConfiguration(
  options: AgentOptions,
): AgentConfiguration | null {
  const slackTrigger =
    createTrigger(options, "slack_mention") ??
    createTrigger(options, "slack_channel");
  const outputChannel = options.resources.find(
    (resource) => resource.kind === "slack_channel",
  );
  const trigger =
    createTrigger(options, "sentry_issue") ??
    createTrigger(options, "datadog_monitor") ??
    slackTrigger;
  if (!trigger) return null;

  const reporting =
    trigger.kind === "slack_channel" || trigger.kind === "slack_mention"
      ? ({ mode: "thread" } as const)
      : outputChannel
        ? ({
            mode: "output_channel",
            integrationAccountId: outputChannel.integrationAccountId,
            outputChannelId: outputChannel.externalId,
          } as const)
        : null;
  if (!reporting) return null;

  return {
    name: "",
    description: "",
    model: "instance/default",
    instructions:
      "Investigate the incident, correlate it with recent code changes, explain customer impact, and recommend the smallest safe remediation.",
    enabled: true,
    prMode: "disabled",
    repositoryIds: [],
    contextAccountIds: [],
    contextResourceIds: [],
    secretIds: [],
    createLinearTickets: false,
    linearIssueTemplate: "{{description}}\n\n{{evidence}}\n\n{{remediation}}",
    trigger,
    reporting,
  };
}

export function AgentEditPage() {
  const { agentId } = useParams();
  const navigate = useNavigate();
  const isNew = !agentId;
  const [options, setOptions] = useState<AgentOptions>(EMPTY_OPTIONS);
  const [configuration, setConfiguration] =
    useState<AgentConfiguration | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useDocumentTitle(
    isNew ? "New agent" : configuration?.name ? `Edit ${configuration.name}` : "Edit agent",
  );

  useEffect(() => {
    let cancelled = false;

    void Promise.all([
      fetchAgentOptions(),
      agentId ? fetchAgent(agentId) : Promise.resolve(null),
    ])
      .then(([loadedOptions, agent]) => {
        if (cancelled) return;
        setOptions(loadedOptions);
        setConfiguration(
          agent?.configuration ?? createDefaultConfiguration(loadedOptions),
        );
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "Unable to load agent");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [agentId]);

  const triggerAvailability = useMemo(
    () =>
      new Map(
        TRIGGERS.map(({ kind }) => [
          kind,
          resourcesForTrigger(options, kind).length > 0,
        ]),
      ),
    [options],
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!configuration) return;
    if (!configuration.name.trim()) {
      setError("Give this agent a name.");
      return;
    }
    if (!configuration.instructions.trim()) {
      setError("Add investigation instructions.");
      return;
    }
    if (
      configuration.prMode !== "disabled" &&
      configuration.repositoryIds.length === 0
    ) {
      setError("Choose at least one repository when remediation is enabled.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const savedAgentId = await saveAgent(agentId, configuration);
      navigate(`/agents/${savedAgentId}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to save agent");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <AppShell active="agents" density="edit">
        <p className="pageState">Loading agent configuration…</p>
      </AppShell>
    );
  }

  if (!configuration) {
    return (
      <AppShell active="agents" density="edit">
        <section className="emptyState">
          <h1>Connect an integration first</h1>
          <p>
            An agent needs a Sentry project, Datadog monitor, or Slack channel
            before it can be configured.
          </p>
          <Link className="button button--primary" to="/settings">
            Open integrations
          </Link>
          {error ? <p className="formError">{error}</p> : null}
        </section>
      </AppShell>
    );
  }

  const slackChannels = options.resources.filter(
    (resource) => resource.kind === "slack_channel",
  );

  return (
    <AppShell active="agents" density="edit">
      <section className="detailHeading editHeading">
        <div>
          <h1>{isNew ? "New agent" : configuration.name}</h1>
          <p>Configure when and how this agent investigates incidents.</p>
        </div>
        <div className="buttonGroup">
          <button className="button button--secondary" disabled type="button">
            Run test
          </button>
          <button
            className="button button--primary"
            disabled={saving}
            form="agent-form"
            type="submit"
          >
            {saving ? "Saving…" : isNew ? "Create agent" : "Save changes"}
          </button>
        </div>
      </section>

      {error ? <p className="formError">{error}</p> : null}

      <form className="agentForm" id="agent-form" onSubmit={submit}>
        <div className="formColumn">
          <FormSection
            description="Identify this agent and choose the model used for investigations."
            title="General"
          >
            <div className="inlineFields">
              <label className="field field--grow">
                <span>Name</span>
                <input
                  autoFocus={isNew}
                  name="name"
                  onChange={(event) =>
                    setConfiguration({
                      ...configuration,
                      name: event.target.value,
                    })
                  }
                  value={configuration.name}
                />
              </label>
              <label className="field field--model">
                <span>Provider / model</span>
                <span className="selectWrap">
                  <select
                    name="model"
                    onChange={(event) =>
                      setConfiguration({
                        ...configuration,
                        model: event.target.value,
                      })
                    }
                    value={configuration.model}
                  >
                    <option value="instance/default">Instance default</option>
                  </select>
                  <ChevronDownIcon />
                </span>
              </label>
            </div>
            <label className="field">
              <span>Description</span>
              <textarea
                name="description"
                onChange={(event) =>
                  setConfiguration({
                    ...configuration,
                    description: event.target.value,
                  })
                }
                rows={2}
                value={configuration.description}
              />
            </label>
          </FormSection>

          <FormSection
            description="Choose the event that starts a new investigation."
            title="Trigger"
          >
            <div className="choiceList">
              {TRIGGERS.map((trigger) => {
                const selected = configuration.trigger.kind === trigger.kind;
                const available = triggerAvailability.get(trigger.kind) ?? false;
                return (
                  <label
                    className={`choiceCard ${selected ? "isSelected" : ""} ${
                      available ? "" : "isDisabled"
                    }`}
                    key={trigger.kind}
                  >
                    <input
                      checked={selected}
                      disabled={!available}
                      name="trigger"
                      onChange={() => {
                        const nextTrigger = createTrigger(options, trigger.kind);
                        if (!nextTrigger) return;
                        const canReportInThread =
                          nextTrigger.kind === "slack_channel" ||
                          nextTrigger.kind === "slack_mention";
                        const outputChannel = slackChannels[0];
                        setConfiguration({
                          ...configuration,
                          trigger: nextTrigger,
                          reporting: canReportInThread
                            ? { mode: "thread" }
                            : outputChannel
                              ? {
                                  mode: "output_channel",
                                  integrationAccountId:
                                    outputChannel.integrationAccountId,
                                  outputChannelId: outputChannel.externalId,
                                }
                              : configuration.reporting,
                        });
                      }}
                      type="radio"
                      value={trigger.kind}
                    />
                    <span className="radioMark" />
                    <span>
                      <strong>{trigger.title}</strong>
                      <small>
                        {available
                          ? trigger.description
                          : `${trigger.description} Connect it in Settings.`}
                      </small>
                    </span>
                  </label>
                );
              })}
            </div>
            <TriggerResourcePicker
              configuration={configuration}
              options={options}
              setConfiguration={setConfiguration}
            />
          </FormSection>
        </div>

        <div className="formColumn">
          <FormSection
            description="Give the agent context, constraints, and investigation priorities."
            title="Instructions"
          >
            <label className="field field--instructions">
              <span className="srOnly">Agent instructions</span>
              <textarea
                name="instructions"
                onChange={(event) =>
                  setConfiguration({
                    ...configuration,
                    instructions: event.target.value,
                  })
                }
                rows={5}
                value={configuration.instructions}
              />
            </label>
            <label className="field">
              <span>
                Pull request fixes
              </span>
              <span className="selectWrap">
              <select
                name="prMode"
                onChange={(event) =>
                  setConfiguration({
                    ...configuration,
                    prMode: event.target.value as AgentConfiguration["prMode"],
                  })
                }
                value={
                  configuration.prMode === "disabled"
                    ? "manual"
                    : configuration.prMode
                }
              >
                <option value="manual">On request</option>
                <option value="always">Always</option>
              </select>
              <ChevronDownIcon />
              </span>
            </label>
          </FormSection>

          <FormSection
            description="The agent selects from these repositories for each investigation."
            title="GitHub repositories"
          >
            {options.repositories.length === 0 ? (
              <p className="inlineEmpty">
                No repositories available. Connect GitHub in{" "}
                <Link to="/settings">Settings</Link>.
              </p>
            ) : (
              <div className="repositoryList">
                {options.repositories.map((repository) => {
                  const selected = configuration.repositoryIds.includes(repository.id);
                  return (
                    <label className="repositoryRow repositoryRow--selectable" key={repository.id}>
                      <span className="repositoryIcon">
                        <RepositoryIcon />
                      </span>
                      <strong>{repository.fullName}</strong>
                      <span className="connectedLabel">
                        {repository.private ? "Private" : "Public"} ·{" "}
                        {repository.defaultBranch}
                      </span>
                      <input
                        checked={selected}
                        onChange={(event) => {
                          const repositoryIds = event.target.checked
                            ? [...configuration.repositoryIds, repository.id]
                            : configuration.repositoryIds.filter(
                                (id) => id !== repository.id,
                              );
                          setConfiguration({
                            ...configuration,
                            repositoryIds,
                            prMode:
                              repositoryIds.length === 0
                                ? "disabled"
                                : configuration.prMode === "always"
                                  ? "always"
                                  : "manual",
                          });
                        }}
                        type="checkbox"
                      />
                    </label>
                  );
                })}
              </div>
            )}
          </FormSection>

          <FormSection
            description="Choose where completed investigation reports are delivered."
            title="Reporting"
          >
            <div className="inlineFields">
              <label className="field field--grow">
                <span>Mode</span>
                <span className="selectWrap">
                  <select
                    name="reportMode"
                    onChange={(event) => {
                      const mode = event.target.value as
                        | "thread"
                        | "output_channel"
                        | "both";
                      if (mode === "thread") {
                        setConfiguration({
                          ...configuration,
                          reporting: { mode },
                        });
                        return;
                      }
                      const reporting = configuration.reporting;
                      const current =
                        reporting.mode === "thread"
                          ? slackChannels[0]
                          : slackChannels.find(
                              (channel) =>
                                channel.integrationAccountId ===
                                  reporting.integrationAccountId &&
                                channel.externalId ===
                                  reporting.outputChannelId,
                            ) ?? slackChannels[0];
                      if (!current) return;
                      setConfiguration({
                        ...configuration,
                        reporting: {
                          mode,
                          integrationAccountId: current.integrationAccountId,
                          outputChannelId: current.externalId,
                        },
                      });
                    }}
                    value={configuration.reporting.mode}
                  >
                    {(configuration.trigger.kind === "slack_channel" ||
                      configuration.trigger.kind === "slack_mention") && (
                      <option value="thread">Source thread only</option>
                    )}
                    <option disabled={slackChannels.length === 0} value="output_channel">
                      Output channel only
                    </option>
                    {(configuration.trigger.kind === "slack_channel" ||
                      configuration.trigger.kind === "slack_mention") && (
                      <option disabled={slackChannels.length === 0} value="both">
                        Thread and output channel
                      </option>
                    )}
                  </select>
                  <ChevronDownIcon />
                </span>
              </label>
              {configuration.reporting.mode !== "thread" ? (
                <label className="field field--grow">
                  <span>Output channel</span>
                  <span className="selectWrap">
                    <select
                      name="outputChannel"
                      onChange={(event) => {
                        const channel = slackChannels.find(
                          (candidate) => candidate.id === event.target.value,
                        );
                        if (!channel || configuration.reporting.mode === "thread") return;
                        setConfiguration({
                          ...configuration,
                          reporting: {
                            mode: configuration.reporting.mode,
                            integrationAccountId: channel.integrationAccountId,
                            outputChannelId: channel.externalId,
                          },
                        });
                      }}
                      value={
                        slackChannels.find(
                          (channel) =>
                            configuration.reporting.mode !== "thread" &&
                            channel.integrationAccountId ===
                              configuration.reporting.integrationAccountId &&
                            channel.externalId ===
                              configuration.reporting.outputChannelId,
                        )?.id ?? ""
                      }
                    >
                      {slackChannels.map((channel) => (
                        <option key={channel.id} value={channel.id}>
                          {slackChannelLabel(channel.displayName)}
                        </option>
                      ))}
                    </select>
                    <ChevronDownIcon />
                  </span>
                </label>
              ) : null}
            </div>
          </FormSection>
        </div>
      </form>
    </AppShell>
  );
}

function TriggerResourcePicker({
  configuration,
  options,
  setConfiguration,
}: {
  configuration: AgentConfiguration;
  options: AgentOptions;
  setConfiguration: (configuration: AgentConfiguration) => void;
}) {
  const trigger = configuration.trigger;
  const resources = resourcesForTrigger(options, trigger.kind);
  const selectedIds =
    trigger.kind === "sentry_issue"
      ? trigger.projectIds
      : trigger.kind === "datadog_monitor"
        ? trigger.monitorIds
        : trigger.kind === "slack_channel"
          ? [trigger.channelId]
          : trigger.channelIds;

  if (trigger.kind === "slack_mention") {
    return (
      <label className="field">
        <span>Channel scope</span>
        <span className="selectWrap">
          <select
            onChange={(event) => {
              const resource = resources.find(
                (candidate) => candidate.id === event.target.value,
              );
              setConfiguration({
                ...configuration,
                trigger: {
                  kind: "slack_mention",
                  integrationAccountId:
                    resource?.integrationAccountId ?? trigger.integrationAccountId,
                  channelIds: resource ? [resource.externalId] : [],
                },
              });
            }}
            value={
              resources.find(
                (resource) =>
                  resource.integrationAccountId === trigger.integrationAccountId &&
                  resource.externalId === trigger.channelIds[0],
              )?.id ?? ""
            }
          >
            <option value="">All available channels</option>
            {resources.map((resource) => (
              <option key={resource.id} value={resource.id}>
                {slackChannelLabel(resource.displayName)}
              </option>
            ))}
          </select>
          <ChevronDownIcon />
        </span>
      </label>
    );
  }

  if (trigger.kind === "slack_channel") {
    return (
      <label className="field">
        <span>Channel</span>
        <span className="selectWrap">
          <select
            onChange={(event) => {
              const resource = resources.find(
                (candidate) => candidate.id === event.target.value,
              );
              if (!resource) return;
              setConfiguration({
                ...configuration,
                trigger: {
                  kind: "slack_channel",
                  integrationAccountId: resource.integrationAccountId,
                  channelId: resource.externalId,
                },
              });
            }}
            value={
              resources.find(
                (resource) =>
                  resource.integrationAccountId === trigger.integrationAccountId &&
                  resource.externalId === trigger.channelId,
              )?.id ?? ""
            }
          >
            {resources.map((resource) => (
              <option key={resource.id} value={resource.id}>
                {slackChannelLabel(resource.displayName)}
              </option>
            ))}
          </select>
          <ChevronDownIcon />
        </span>
      </label>
    );
  }

  return (
    <div className="resourcePicker">
      <span>{trigger.kind === "sentry_issue" ? "Projects" : "Monitors"}</span>
      <div>
        {resources.map((resource) => {
          const sameAccount =
            resource.integrationAccountId === trigger.integrationAccountId;
          const checked = sameAccount && selectedIds.includes(resource.externalId);
          return (
            <label key={resource.id}>
              <input
                checked={checked}
                onChange={(event) => {
                  const currentIds = sameAccount ? selectedIds : [];
                  const nextIds = event.target.checked
                    ? [...currentIds, resource.externalId]
                    : currentIds.filter((id) => id !== resource.externalId);
                  setConfiguration({
                    ...configuration,
                    trigger:
                      trigger.kind === "sentry_issue"
                        ? {
                            kind: "sentry_issue",
                            integrationAccountId: resource.integrationAccountId,
                            projectIds: nextIds,
                          }
                        : {
                            kind: "datadog_monitor",
                            integrationAccountId: resource.integrationAccountId,
                            monitorIds: nextIds,
                          },
                  });
                }}
                type="checkbox"
              />
              <span>{resource.displayName}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function FormSection({
  children,
  description,
  title,
}: {
  children: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <section className="formSection">
      <header>
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
      </header>
      <div className="formSection__body">{children}</div>
    </section>
  );
}
