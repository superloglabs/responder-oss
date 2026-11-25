import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { IconAlertCircle, IconEye, IconEyeOff } from "@tabler/icons-react";
import { Button } from "../design-system";
import {
  fetchJiraIssueTypes,
  fetchJiraProjects,
  saveDiscordWebhook,
  saveReplicasWebhook,
  type SignalJiraIssueType,
  type SignalJiraMode,
  type SignalJiraProject,
  type SignalJiraSettings,
  type SignalSettings,
} from "./model";
import type { SaveSettings, SettingsPageProps } from "./settings";
import { sourceActions, type SourceActions } from "./setup-data";
import { ChannelSelect } from "./setup-shared";
import { SettingsGroup, SettingsPage, SettingsRow, SourceRow } from "./shared";

export function SettingsNotifications({ data, save, setSettings, status }: SettingsPageProps) {
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
    <SettingsGroup title="Discord">
      <div className="signalSettingsCard signalSettingsCard--rows">
        <DiscordWebhook connected={settings.discord.connected} onSaved={(saved) => setSettings(saved, true)} />
      </div>
    </SettingsGroup>
    {actions.summary("jira") && <JiraSettings actions={actions} value={settings.jira} save={save} />}
    <SettingsGroup title="Coding agents">
      <div className="signalSettingsCard signalSettingsCard--rows">
        <ReplicasWebhook connected={settings.replicas.connected} onSaved={(saved) => setSettings(saved, true)} />
      </div>
    </SettingsGroup>
  </SettingsPage>;
}

const jiraPath = "/signal/setup/context/jira";

const modeDescriptions: Record<SignalJiraMode | "off", string> = {
  off: "Findings are not filed in Jira.",
  button: "Members file a finding from its page or its Slack message with Create Jira issue.",
  automatic: "Signal files every finding it posts, starting now. Findings kept below the minimum severity are not filed.",
};

type Loaded<T> = { key: string; items: T[] } | { key: string; error: string };

// Projects or issue types for `key`, loaded again when it changes. Null
// skips loading. `onLoad` hears of each list that is still current: an
// answer for an earlier key is dropped.
function useJiraList<T>(key: string | null, load: () => Promise<T[]>, onLoad?: (key: string, items: T[]) => void) {
  const [loaded, setLoaded] = useState<Loaded<T> | null>(null);
  const latestOnLoad = useRef(onLoad);
  useEffect(() => { latestOnLoad.current = onLoad; });
  useEffect(() => {
    if (key === null) return;
    let current = true;
    load()
      .then((items) => {
        if (!current) return;
        setLoaded({ key, items });
        latestOnLoad.current?.(key, items);
      })
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
  // The mode chosen while turning Jira on, before a project lets it be saved.
  const [draftMode, setDraftMode] = useState<SignalJiraMode | null>(null);
  // A project chosen but not saved yet. Its issue types load once, and it is
  // saved with its default type then, unless something newer replaced it.
  const [pending, setPending] = useState<SignalJiraProject | null>(null);
  const mode = value?.mode ?? draftMode ?? "off";
  const projectId = pending?.id ?? value?.projectId ?? null;
  const projects = useJiraList(mode !== "off" && accountId ? accountId : null, () => fetchJiraProjects(accountId!));
  const issueTypes = useJiraList(
    mode !== "off" && accountId && projectId ? `${accountId}/${projectId}` : null,
    () => fetchJiraIssueTypes(accountId!, projectId!),
    // A chosen project is saved with its default type once its own types
    // load. Choosing another project or Off first drops this answer.
    (key, types) => {
      const issueType = defaultIssueType(types);
      if (!pending || !accountId || mode === "off" || key !== `${accountId}/${pending.id}` || !issueType) return;
      saveJira({ integrationAccountId: accountId, projectId: pending.id, projectKey: pending.key, issueTypeId: issueType.id, mode });
    },
  );

  function saveJira(next: SignalJiraSettings | null) {
    setDraftMode(null);
    setPending(null);
    save({ jira: next });
  }

  function chooseMode(next: SignalJiraMode | "off") {
    if (next === "off") { saveJira(null); return; }
    if (value) { saveJira({ ...value, mode: next }); return; }
    setDraftMode(next);
  }

  function chooseProject(id: string) {
    const project = projects && "items" in projects ? projects.items.find((candidate) => candidate.id === id) : undefined;
    if (!project || !accountId || mode === "off") return;
    setPending(project.id === value?.projectId ? null : project);
  }

  function chooseIssueType(issueTypeId: string) {
    const project = pending ?? (value ? { id: value.projectId, key: value.projectKey } : null);
    if (!project || !accountId || mode === "off") return;
    saveJira({ integrationAccountId: accountId, projectId: project.id, projectKey: project.key, issueTypeId, mode });
  }

  const site = accounts.map((account) => account.details?.url?.replace(/^https:\/\//u, "") ?? account.displayName).join(", ");
  const issueTypeId = pending ? "" : value?.issueTypeId ?? "";
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
              onChange={(e) => chooseProject(e.target.value)}>
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

// The webhook URL of a Replicas automation.
function ReplicasWebhook({ connected, onSaved }: { connected: boolean; onSaved: (settings: SignalSettings) => void }) {
  return <WebhookRow connected={connected} onSaved={onSaved} save={saveReplicasWebhook}
    label="Send to Replicas"
    connectedDescription="Findings posted to Slack from now on have a Send to Replicas button. It starts your Replicas automation with the finding's prompt."
    description="Add a Send to Replicas button to findings in Slack. In Replicas, create an automation with a custom webhook trigger, then paste its URL here."
    inputLabel="Replicas webhook URL"
    placeholder="https://api.replicas.dev/v1/automations/webhook/whtok_…"
    note="Stored encrypted. Anyone with the URL can start the automation."
    connectLabel="Connect Replicas" />;
}

// The webhook URL of a Discord channel that findings are posted to.
export function DiscordWebhook({ connected, onSaved }: { connected: boolean; onSaved: (settings: SignalSettings) => void }) {
  return <WebhookRow connected={connected} onSaved={onSaved} save={saveDiscordWebhook}
    label="Discord channel"
    connectedDescription="Every finding is posted to your Discord channel. Feedback, Jira, and coding agents are on each finding's page."
    description="Post findings to a Discord channel. In Discord, open the channel's settings, then Integrations, then Webhooks, and copy a webhook URL."
    inputLabel="Discord webhook URL"
    placeholder="https://discord.com/api/webhooks/…"
    note="Stored encrypted. Signal posts a short message to check it. Anyone with the URL can post to the channel."
    connectLabel="Connect Discord" />;
}

// A webhook URL. It is a secret, so once saved it can only be removed or
// replaced, not shown.
function WebhookRow({ connected, onSaved, save, label, connectedDescription, description, inputLabel, placeholder, note, connectLabel }: {
  connected: boolean;
  onSaved: (settings: SignalSettings) => void;
  save: (webhookUrl: string | null) => Promise<SignalSettings>;
  label: string;
  connectedDescription: string;
  description: string;
  inputLabel: string;
  placeholder: string;
  note: string;
  connectLabel: string;
}) {
  const [url, setUrl] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [replacing, setReplacing] = useState(false);

  async function submit(webhookUrl: string | null) {
    setBusy(true);
    setError("");
    try {
      onSaved(await save(webhookUrl));
      setUrl("");
      setReplacing(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  function connect(event: FormEvent) {
    event.preventDefault();
    void submit(url.trim());
  }

  if (connected && !replacing) {
    return <SettingsRow label={label}
      description={error ? <span className="signalError" role="alert">{error}</span> : connectedDescription}>
      <span className="signalReplicasActions">
        <Button disabled={busy} onClick={() => setReplacing(true)}>Replace URL</Button>
        <Button disabled={busy} loading={busy} onClick={() => void submit(null)}>Remove</Button>
      </span>
    </SettingsRow>;
  }

  return <SettingsRow stacked label={label} description={description}>
    <form className="signalReplicasForm" onSubmit={connect}>
      <div className={`signalInput${error ? " signalInput--error" : ""}`}>
        <div className="signalSecret">
          <input aria-label={inputLabel} type={show ? "text" : "password"} autoComplete="off" spellCheck={false}
            disabled={busy} placeholder={placeholder} value={url}
            onChange={(e) => { setUrl(e.target.value); setError(""); }} />
          <button type="button" aria-label={show ? "Hide URL" : "Show URL"} onClick={() => setShow(!show)}>
            {show ? <IconEyeOff size={14} /> : <IconEye size={14} />}
          </button>
        </div>
        {error ? <p className="signalFieldError" role="alert"><IconAlertCircle size={14} />{error}</p> : <p>{note}</p>}
      </div>
      <span className="signalReplicasActions">
        {replacing && <Button disabled={busy} onClick={() => { setReplacing(false); setUrl(""); setError(""); }}>Cancel</Button>}
        <Button type="submit" variant="primary" loading={busy} disabled={busy || !url.trim()}>{connectLabel}</Button>
      </span>
    </form>
  </SettingsRow>;
}
