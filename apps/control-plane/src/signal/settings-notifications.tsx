import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../design-system";
import {
  fetchJiraIssueTypes,
  fetchJiraProjects,
  type SignalJiraIssueType,
  type SignalJiraMode,
  type SignalJiraProject,
  type SignalJiraSettings,
} from "./model";
import type { SaveSettings, SettingsPageProps } from "./settings";
import { sourceActions, type SourceActions } from "./setup-data";
import { ChannelSelect } from "./setup-shared";
import { SettingsGroup, SettingsPage, SettingsRow, SourceRow } from "./shared";

export function SettingsNotifications({ data, save, status }: SettingsPageProps) {
  const navigate = useNavigate();
  const { integrations, options, settings } = data;
  const actions = sourceActions({ integrations, otelServices: null, listPath: "/signal/setup/notifications", navigate });
  const connected = actions.connected("slack");
  const workspace = actions.accounts("slack").map((account) => account.displayName).join(", ");
  return <SettingsPage title="Notifications" description="Where findings are posted and filed." status={status}>
    <SettingsGroup title="Slack">
      <div className="signalSettingsCard">
        <SourceRow provider="slack" name="Slack"
          description={connected ? workspace || "Connected" : "Connect your workspace to post findings."}
          action={connected
            ? <Button aria-label="Manage Slack" onClick={() => actions.manage("slack")}>Manage</Button>
            : <Button disabled={!actions.summary("slack")?.connectUrl} onClick={() => actions.connect("slack")}>Connect Slack</Button>} />
        <div className="signalSettingsCard--rows">
          <SettingsRow label="Findings channel" description="Every finding is posted here.">
            <ChannelSelect options={options} value={settings.slack}
              onChange={(slack) => save({ slack })} />
          </SettingsRow>
        </div>
      </div>
    </SettingsGroup>
    {actions.summary("jira") && <JiraSettings actions={actions} value={settings.jira} save={save} />}
  </SettingsPage>;
}

const jiraPath = "/signal/setup/sources/jira";

const modeDescriptions: Record<SignalJiraMode | "off", string> = {
  off: "Findings are not filed in Jira.",
  button: "Members file a finding from its page or its Slack message with Create Jira issue.",
  automatic: "Signal files every finding it posts, starting now. Findings kept below the minimum severity are not filed.",
};

type Loaded<T> = { key: string; items: T[] } | { key: string; error: string };

// Projects or issue types for `key`, loaded again when it changes. Null
// skips loading.
function useJiraList<T>(key: string | null, load: () => Promise<T[]>) {
  const [loaded, setLoaded] = useState<Loaded<T> | null>(null);
  useEffect(() => {
    if (key === null) return;
    let current = true;
    load()
      .then((items) => { if (current) setLoaded({ key, items }); })
      .catch((failure: unknown) => {
        if (current) setLoaded({ key, error: failure instanceof Error ? failure.message : "Could not load from Jira." });
      });
    return () => { current = false; };
    // `load` is rebuilt each render; `key` names what it loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return key !== null && loaded?.key === key ? loaded : null;
}

// The issue type findings get by default: Bug when the project has one.
function defaultIssueType(types: SignalJiraIssueType[]) {
  return types.find((type) => type.name.toLowerCase() === "bug") ?? types[0] ?? null;
}

function JiraSettings({ actions, value, save }: {
  actions: SourceActions;
  value: SignalJiraSettings | null;
  save: SaveSettings;
}) {
  const navigate = useNavigate();
  const accounts = actions.accounts("jira");
  const connected = actions.connected("jira") && accounts.length > 0;
  // The connection in use, else the first one.
  const accountId = accounts.find((account) => account.id === value?.integrationAccountId)?.id ?? accounts[0]?.id ?? null;
  // Choices made while turning Jira on, before a project and issue type let
  // them be saved.
  const [draft, setDraft] = useState<{ mode: SignalJiraMode; project: SignalJiraProject | null; issueTypeId: string | null } | null>(null);
  const mode = value?.mode ?? draft?.mode ?? "off";
  const projectId = value?.projectId ?? draft?.project?.id ?? null;
  const projects = useJiraList(mode !== "off" && accountId ? accountId : null, () => fetchJiraProjects(accountId!));
  const issueTypes = useJiraList(
    mode !== "off" && accountId && projectId ? `${accountId}/${projectId}` : null,
    () => fetchJiraIssueTypes(accountId!, projectId!),
  );

  function saveJira(next: SignalJiraSettings | null) {
    setDraft(null);
    save({ jira: next });
  }

  function chooseMode(next: SignalJiraMode | "off") {
    if (next === "off") { saveJira(null); return; }
    if (value) { saveJira({ ...value, mode: next }); return; }
    setDraft({ mode: next, project: draft?.project ?? null, issueTypeId: draft?.issueTypeId ?? null });
  }

  async function chooseProject(id: string) {
    const project = projects && "items" in projects ? projects.items.find((candidate) => candidate.id === id) : undefined;
    if (!project || !accountId || mode === "off") return;
    if (!value) setDraft({ mode, project, issueTypeId: null });
    // A new project has its own issue types, so its default is chosen and
    // saved with it.
    let types: SignalJiraIssueType[];
    try {
      types = await fetchJiraIssueTypes(accountId, project.id);
    } catch {
      return;
    }
    const issueType = defaultIssueType(types);
    if (!issueType) return;
    saveJira({ integrationAccountId: accountId, projectId: project.id, projectKey: project.key, issueTypeId: issueType.id, mode });
  }

  function chooseIssueType(issueTypeId: string) {
    if (value) { saveJira({ ...value, issueTypeId }); return; }
    const project = draft?.project;
    if (!project || !accountId || mode === "off") return;
    saveJira({ integrationAccountId: accountId, projectId: project.id, projectKey: project.key, issueTypeId, mode });
  }

  const site = accounts.map((account) => account.details?.url?.replace(/^https:\/\//u, "") ?? account.displayName).join(", ");
  const issueTypeId = value?.issueTypeId ?? draft?.issueTypeId ?? "";
  return <SettingsGroup title="Jira">
    <div className="signalSettingsCard">
      <SourceRow provider="jira" name="Jira"
        description={connected ? site || "Connected" : "Connect Jira Cloud to file findings as issues."}
        action={connected
          ? <Button aria-label="Manage Jira" onClick={() => navigate(jiraPath)}>Manage</Button>
          : <Button disabled={actions.unavailable("jira")} onClick={() => navigate(`${jiraPath}?next=notifications`)}>Connect Jira</Button>} />
      {connected && <div className="signalSettingsCard--rows">
        <SettingsRow label="File findings in Jira" description={modeDescriptions[mode]}>
          <select className="signalSettingsSelect" aria-label="File findings in Jira" value={mode}
            onChange={(e) => chooseMode(e.target.value as SignalJiraMode | "off")}>
            <option value="off">Off</option>
            <option value="button">With a button</option>
            <option value="automatic">Every finding</option>
          </select>
        </SettingsRow>
        {mode !== "off" && <>
          <SettingsRow label="Project" description={projects && "error" in projects ? projects.error
            : value ? `Issues are created in ${value.projectKey}.` : "Choose where issues are created."}>
            <select className="signalSettingsSelect" aria-label="Jira project" value={projectId ?? ""}
              disabled={!projects || "error" in projects}
              onChange={(e) => void chooseProject(e.target.value)}>
              {!projectId && <option value="">{projects ? "Choose a project" : "Loading…"}</option>}
              {projects && "items" in projects
                ? projects.items.map((project) => <option key={project.id} value={project.id}>{project.name} ({project.key})</option>)
                : value && <option value={value.projectId}>{value.projectKey}</option>}
            </select>
          </SettingsRow>
          {projectId && <SettingsRow label="Issue type" description={issueTypes && "error" in issueTypes ? issueTypes.error : "The type each issue is created with."}>
            <select className="signalSettingsSelect" aria-label="Jira issue type" value={issueTypeId}
              disabled={!issueTypes || "error" in issueTypes}
              onChange={(e) => chooseIssueType(e.target.value)}>
              {!issueTypeId && <option value="">{issueTypes ? "Choose an issue type" : "Loading…"}</option>}
              {issueTypes && "items" in issueTypes && issueTypes.items.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}
            </select>
          </SettingsRow>}
        </>}
      </div>}
    </div>
  </SettingsGroup>;
}
