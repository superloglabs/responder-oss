import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { IconPlus } from "@tabler/icons-react";
import { Button } from "../design-system";
import { accountSummary } from "./manage-model";
import type { SettingsPageProps } from "./settings";
import {
  contextSources,
  isConnectPage,
  sourceActions,
  telemetrySources,
  useOtelServices,
  type Source,
  type SourceActions,
} from "./setup-data";
import { RepositoryPicker, SourcePage, SourceRows } from "./setup-shared";
import { SettingsGroup, SettingsPage, SourceRow } from "./shared";

const listPath = "/signal/setup/sources";

export function SettingsSources({ data, organizationId, reload, save, status, provider, mode }: SettingsPageProps & {
  provider: string | undefined;
  mode: string | undefined;
}) {
  const navigate = useNavigate();
  const otel = useOtelServices(`${provider ?? ""}/${mode ?? ""}`);
  const actions = sourceActions({ integrations: data.integrations, otelServices: otel.count, listPath, navigate });

  if (isConnectPage(provider) && (!mode || mode === "connect")) {
    return <section className="signalSettingsSource">
      <SourcePage page={provider} mode={mode} actions={actions} otel={otel} organizationId={organizationId}
        onChanged={(removed) => reload(removed)} />
    </section>;
  }
  if (provider === "telemetry" && !mode) {
    return <AddSources title="Add telemetry" description="Signal reads these to find problems. It never changes your data."
      sources={telemetrySources} actions={actions} otelServices={otel.count} />;
  }
  if (provider === "context" && !mode) {
    return <AddSources title="Add context" description="Signal skips problems already tracked in tickets, alerts, or Slack."
      sources={contextSources} actions={actions} otelServices={otel.count} />;
  }
  if (provider) return <Navigate replace to={listPath} />;

  const summary = (source: Source) => source.provider === "otel"
    ? `${otel.count} ${otel.count === 1 ? "service" : "services"} sending data`
    : actions.accounts(source.provider).map((account) => accountSummary(source.provider, account)).join(", ") || "Connected";
  const rows = (sources: Source[], empty: string) => {
    const connected = sources.filter((source) => actions.connected(source.provider));
    return <div className="signalSettingsCard">
      {connected.map((source) => <SourceRow key={source.provider} provider={source.provider} name={source.name}
        description={summary(source)}
        action={<Button aria-label={`Manage ${source.name}`} onClick={() => actions.manage(source.provider)}>Manage</Button>} />)}
      {connected.length === 0 && <p className="signalSettingsEmpty">{empty}</p>}
    </div>;
  };

  return <SettingsPage title="Sources" description="What Signal reads to find and explain problems. It never changes your data or code." status={status}>
    <SettingsGroup title="Telemetry" action={<Button onClick={() => navigate(`${listPath}/telemetry`)}><IconPlus aria-hidden="true" size={14} stroke={2} />Add source</Button>}>
      {otel.count === null
        ? <p className="signalLoading" role="status">Loading…</p>
        : rows(telemetrySources, "No telemetry is connected. Signal needs at least one source to find problems.")}
    </SettingsGroup>
    <SettingsGroup title="Code">
      <GitHubSource actions={actions} repositories={data.options.repositories} selected={data.settings.repositoryIds}
        onSave={(repositoryIds) => save({ repositoryIds })} />
    </SettingsGroup>
    <SettingsGroup title="Context" action={<Button onClick={() => navigate(`${listPath}/context`)}><IconPlus aria-hidden="true" size={14} stroke={2} />Add context</Button>}>
      {rows(contextSources, "No context is connected. Linear and PostHog help Signal skip known problems and count who is affected.")}
    </SettingsGroup>
  </SettingsPage>;
}

function GitHubSource({ actions, repositories, selected, onSave }: {
  actions: SourceActions;
  repositories: SettingsPageProps["data"]["options"]["repositories"];
  selected: string[];
  onSave: (repositoryIds: string[]) => void;
}) {
  // The repositories being chosen, while the picker is open.
  const [editing, setEditing] = useState<string[] | null>(null);
  if (!actions.connected("github")) {
    return <div className="signalSettingsCard">
      <SourceRow provider="github" name="GitHub" description="Connect GitHub to choose the repositories Signal can read."
        action={<Button disabled={!actions.summary("github")?.connectUrl} onClick={() => actions.connect("github")}>Connect GitHub</Button>} />
    </div>;
  }
  const names = repositories.filter((repository) => selected.includes(repository.id))
    .map((repository) => repository.fullName).sort();
  return <div className="signalSettingsCard">
    <SourceRow provider="github" name="GitHub"
      description={actions.accounts("github").map((account) => account.displayName).join(", ") || "Read-only access"}
      meta={`${selected.length} of ${repositories.length} ${repositories.length === 1 ? "repository" : "repositories"}`}
      action={editing === null && <Button aria-label="Edit repositories" onClick={() => setEditing(selected)}>Edit</Button>}>
      {editing === null
        ? names.length > 0 && <div className="signalChips signalSourceRow__more">{names.map((name) => <code className="signalChip" key={name}>{name}</code>)}</div>
        : <div className="signalSourceRow__more">
          <RepositoryPicker repositories={repositories} selected={editing} onChange={setEditing}
            empty="GitHub has no repositories for Signal to read." />
          <div className="signalSettingsActions">
            <Button onClick={() => setEditing(null)}>Cancel</Button>
            <Button variant="primary" onClick={() => { onSave(editing); setEditing(null); }}>Save</Button>
          </div>
        </div>}
    </SourceRow>
  </div>;
}

function AddSources({ title, description, sources, actions, otelServices }: {
  title: string; description: string; sources: Source[]; actions: SourceActions; otelServices: number | null;
}) {
  const navigate = useNavigate();
  const available = sources.filter((source) => !actions.connected(source.provider));
  return <SettingsPage title={title} description={description}>
    {otelServices === null && sources === telemetrySources
      ? <p className="signalLoading" role="status">Loading…</p>
      : available.length > 0
        ? <SourceRows sources={available} actions={actions} otelServices={otelServices} />
        : <p className="signalNote">Every source here is connected.</p>}
    <footer className="signalSetupActions"><Button onClick={() => navigate(listPath)}>Back</Button></footer>
  </SettingsPage>;
}
