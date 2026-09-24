import { type FormEvent, useEffect, useState } from "react";
import {
  createAutomationCredential,
  deleteAutomationCredential,
  fetchAutomationCredentials,
  rotateAutomationCredential,
  type AutomationCredential,
  type AutomationModelProvider,
} from "../automations-api";
import { AppShell } from "../components/app-shell";
import { AutomationSubscriptionConnect } from "../components/automation-subscription-connect";
import "../components/automation-model-picker.css";
import { SettingsHeading } from "../components/settings-heading";
import { MemberListSkeleton } from "../components/screen-skeletons";
import { useDocumentTitle } from "../use-document-title";
import { automationModelProviders, modelProvider } from "../../../../packages/core/src/automations/model-providers";

function CredentialStatus({ credential }: { credential: AutomationCredential }) {
  return credential.status === "active"
    ? <span className="connectedBadge">Active</span>
    : <span className="connectedBadge connectedBadge--warning">
        {credential.authType === "chatgpt_subscription" ? "Reconnect" : "Invalid"}
      </span>;
}

export function ModelAccessSettingsPage() {
  useDocumentTitle("Model access");
  const [credentials, setCredentials] = useState<AutomationCredential[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [provider, setProvider] = useState<AutomationModelProvider>("openai");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [replacing, setReplacing] = useState<string | null>(null);
  const [replacementKey, setReplacementKey] = useState("");
  const [connectingSubscription, setConnectingSubscription] = useState(false);

  useEffect(() => {
    let active = true;
    void fetchAutomationCredentials()
      .then((loaded) => {
        if (active) setCredentials(loaded);
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : "Unable to load model access");
        }
      });
    return () => {
      active = false;
    };
  }, []);

  async function reload() {
    setCredentials(await fetchAutomationCredentials());
  }

  async function run(id: string, action: () => Promise<string>) {
    setBusyId(id);
    setError(null);
    setNotice(null);
    try {
      setNotice(await action());
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong");
    } finally {
      setBusyId(null);
    }
  }

  function addKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run("new", async () => {
      await createAutomationCredential({ apiKey: apiKey.trim(), label, provider });
      setApiKey("");
      setLabel("");
      return "API key saved.";
    });
  }

  function replaceKey(credential: AutomationCredential) {
    void run(credential.id, async () => {
      await rotateAutomationCredential(credential.id, replacementKey.trim());
      setReplacing(null);
      setReplacementKey("");
      return "API key replaced.";
    });
  }

  function removeCredential(credential: AutomationCredential) {
    if (!window.confirm(`Remove ${credential.label}?`)) return;
    void run(credential.id, async () => {
      await deleteAutomationCredential(credential.id);
      return `${credential.label} removed.`;
    });
  }

  async function subscriptionConnected() {
    setConnectingSubscription(false);
    setNotice("ChatGPT subscription connected.");
    await reload().catch(() => undefined);
  }

  const keys = credentials?.filter((credential) => credential.authType !== "chatgpt_subscription") ?? [];
  const subscriptions = credentials?.filter(
    (credential) => credential.authType === "chatgpt_subscription",
  ) ?? [];

  return (
    <AppShell active="settings" density="settings" redesigned>
      <SettingsHeading active="models" />

      <section className="workspaceSettings">
        <p className="memberAccessNote">
          Automations use included usage by default, billed against your
          monthly allowance. Runs that use your own API key or ChatGPT
          subscription do not use the allowance. Choose the connection for
          each automation in its model picker.
        </p>

        {error ? <p className="settingsNotice settingsNotice--error">{error}</p> : null}
        {notice ? <p className="settingsNotice settingsNotice--success">{notice}</p> : null}

        <form className="inviteForm" onSubmit={addKey}>
          <div>
            <h3>Add an API key</h3>
            <p>Keys are encrypted and never enter the automation sandbox.</p>
          </div>
          <div className="inviteForm__controls">
            <select
              aria-label="Provider"
              onChange={(event) => setProvider(event.target.value as AutomationModelProvider)}
              value={provider}
            >
              {automationModelProviders.map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
            <input
              aria-label="Key label"
              maxLength={120}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Label"
              required
              value={label}
            />
            <input
              aria-label="API key"
              autoComplete="off"
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="API key"
              required
              type="password"
              value={apiKey}
            />
            <button className="button button--primary" disabled={busyId === "new"} type="submit">
              {busyId === "new" ? "Saving…" : "Add key"}
            </button>
          </div>
        </form>

        <div className="memberSection">
          <div className="memberSection__heading">
            <h3>API keys</h3>
            <span>{keys.length}</span>
          </div>
          {credentials === null ? <MemberListSkeleton /> : keys.length === 0 ? (
            <p className="settingsEmpty">No API keys yet.</p>
          ) : (
            <div className="memberList">
              {keys.map((credential) => (
                <div className="memberRow" key={credential.id}>
                  <div className="memberIdentity">
                    <strong>{credential.label}</strong>
                    <span>{modelProvider(credential.provider).name} ·••••{credential.lastFour}</span>
                  </div>
                  <CredentialStatus credential={credential} />
                  {replacing === credential.id ? (
                    <div className="invitationActions">
                      <input
                        aria-label={`New key for ${credential.label}`}
                        autoComplete="off"
                        onChange={(event) => setReplacementKey(event.target.value)}
                        type="password"
                        value={replacementKey}
                      />
                      <button className="memberAction" disabled={!replacementKey.trim() || busyId === credential.id} onClick={() => replaceKey(credential)} type="button">Save</button>
                      <button className="memberAction" onClick={() => setReplacing(null)} type="button">Cancel</button>
                    </div>
                  ) : (
                    <div className="invitationActions">
                      <button className="memberAction" onClick={() => { setReplacing(credential.id); setReplacementKey(""); }} type="button">Replace</button>
                      <button className="memberAction memberAction--danger" disabled={busyId === credential.id} onClick={() => removeCredential(credential)} type="button">Remove</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="memberSection">
          <div className="memberSection__heading">
            <h3>ChatGPT subscription</h3>
            <span>{subscriptions.length}</span>
          </div>
          <p className="memberAccessNote">
            Runs with the Codex harness can use a ChatGPT plan instead of an
            API key. Usage counts against that plan&apos;s Codex limits.
          </p>
          {subscriptions.length > 0 ? (
            <div className="memberList">
              {subscriptions.map((credential) => (
                <div className="memberRow" key={credential.id}>
                  <div className="memberIdentity">
                    <strong>{credential.label}</strong>
                    <span>Codex harness only</span>
                  </div>
                  <CredentialStatus credential={credential} />
                  <div className="invitationActions">
                    <button className="memberAction memberAction--danger" disabled={busyId === credential.id} onClick={() => removeCredential(credential)} type="button">Remove</button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
          {connectingSubscription ? (
            <div className="inviteForm">
              <AutomationSubscriptionConnect onConnected={subscriptionConnected} />
              <div>
                <button className="button button--secondary" onClick={() => setConnectingSubscription(false)} type="button">Cancel</button>
              </div>
            </div>
          ) : (
            <div>
              <button className="button button--secondary" onClick={() => setConnectingSubscription(true)} type="button">
                Connect ChatGPT
              </button>
            </div>
          )}
        </div>
      </section>
    </AppShell>
  );
}
