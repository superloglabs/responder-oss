import { useState } from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { authClient } from "../auth-client";
import { Button } from "../design-system";
import { useDocumentTitle } from "../use-document-title";
import { findingsDestinationChosen, saveDiscordWebhook, saveSignalSettings, type SignalSettings } from "./model";
import { SignalPlanStep } from "./plan";
import { contextSources, isConnectPage, slackScanReady, sourceActions, sourceName, telemetrySources, useOtelServices, useSetupData, type SetupData } from "./setup-data";
import { RepositoryPicker, SlackChannelChecklist, slackScanLabel, SlackScanSwitch, SourcePage, SourceRows } from "./setup-shared";
import { useSignalSetupState } from "./setup-state";
import { SignalSettingsView } from "./settings";
import { FindingsDestinationPicker } from "./destination";
import { destinationBlocker, initialDestination, slackSignInProblem, type FindingsDestination } from "./destination-model";
import { SettingsRow, SignalLogo } from "./shared";

const steps = ["telemetry", "code", "repositories", "slack", "context", "plan"] as const;
type Step = (typeof steps)[number];
const headings: Record<Step, string> = {
  telemetry: "Connect your telemetry",
  code: "Connect your GitHub organization",
  repositories: "Select your repositories",
  slack: "Where should Signal post findings?",
  context: "Add more context",
  plan: "Choose your plan",
};
const descriptions: Record<Step, string> = {
  telemetry: "Signal investigates your telemetry and sends issues with real impact to Slack or Discord.",
  code: "Connect GitHub to choose the repositories Signal can read.",
  repositories: "Signal reads these repositories to find the cause of a problem. It never changes them.",
  slack: "Pick one. You can add the other later in Setup › Notifications.",
  context: "Signal skips problems already tracked in tickets, alerts, or Slack.",
  plan: "Start a monthly subscription to receive investigated findings.",
};
const stepNumber: Record<Step, number> = { telemetry: 1, code: 2, repositories: 2, slack: 3, context: 4, plan: 5 };

// Setup is a step-by-step wizard until Signal has been turned on once, and
// Signal's settings after that.
export function SignalSetup() {
  useDocumentTitle("Signal · Setup");
  const organizationId = authClient.useSession().data?.session.activeOrganizationId;
  const setup = useSetupData(organizationId);
  const state = useSignalSetupState(organizationId, true);
  if (!setup.data || state === "loading") {
    return setup.error
      ? <section className="signalEmpty"><p className="signalError" role="alert">{setup.error}</p><Button onClick={() => setup.reload()}>Try again</Button></section>
      : <p className="signalLoading" role="status">Loading…</p>;
  }
  const props = { data: setup.data, organizationId: organizationId ?? undefined, reload: setup.reload, setSettings: setup.setSettings, setOptions: setup.setOptions };
  return state === "complete" ? <SignalSettingsView {...props} /> : <SignalWizard {...props} />;
}

export interface SetupViewProps {
  data: SetupData;
  organizationId: string | undefined;
  reload: (clear?: boolean) => void;
  setSettings: (settings: SignalSettings, saved?: boolean) => void;
  setOptions: (options: SetupData["options"]) => void;
}

function SignalWizard({ data, organizationId, reload, setSettings, setOptions }: SetupViewProps) {
  const { step: stepParam = "telemetry", page: pageParam, mode } = useParams();
  const step = steps.find((candidate) => candidate === stepParam);
  const page = isConnectPage(pageParam) ? pageParam : undefined;
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { integrations, options, settings } = data;
  // Changes not saved yet, dropped when the settings load again.
  const [edit, setEdit] = useState<{ base: SignalSettings; draft: SignalSettings } | null>(null);
  const draft = edit?.base === settings ? edit.draft : settings;
  const setDraft = (next: SignalSettings) => setEdit({ base: settings, draft: next });
  // The OpenTelemetry page needs the services too, under any step.
  const otel = useOtelServices(step === "telemetry" || page === "otel" ? `${step}/${page}` : null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  // Where findings go. A failed Slack sign-in comes back to Slack.
  const [destination, setDestination] = useState<FindingsDestination | null>(() =>
    searchParams.get("status") === "error" && searchParams.get("integration") === "slack" ? "slack" : initialDestination(settings));

  if (!step || (pageParam && (!page || !["telemetry", "context"].includes(step))) || (mode && (!page || mode !== "connect"))) {
    return <Navigate replace to="/signal/setup" />;
  }

  const returnTo = `/signal/setup/${step}`;
  const actions = sourceActions({ integrations, otelServices: otel.count, listPath: returnTo, navigate });
  const index = steps.indexOf(step);
  const go = (target: Step) => navigate(`/signal/setup/${target}`);

  async function save(next: SignalSettings, then?: Step | "findings") {
    setSaving(true);
    setError("");
    try {
      const saved = await saveSignalSettings(next);
      setSettings(saved, true);
      if (then === "findings") navigate("/signal/findings");
      else if (then) go(then);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  // Findings go to the one destination chosen: choosing Slack removes a
  // Discord webhook saved earlier in this step, and choosing Discord drops
  // the Slack channel.
  async function continueFromDestination() {
    if (destination === "slack" && draft.discord.connected) {
      setSaving(true);
      try {
        setSettings(await saveDiscordWebhook(null), true);
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : "Could not remove the Discord webhook.");
        setSaving(false);
        return;
      }
    }
    await save({ ...draft, slack: destination === "slack" ? draft.slack : null, discord: { connected: destination === "discord" } }, "context");
  }

  // A provider's own site sends people back here with the outcome.
  const failedProvider = searchParams.get("status") === "error" ? searchParams.get("integration") : null;
  const header = <header className="signalWelcome"><h1>Welcome to Superlog</h1><p>Step {stepNumber[step]} out of 5</p></header>;

  if (page) {
    return <section className="signalSetup">
      {header}
      <SourcePage page={page} mode={mode} actions={actions} otel={otel} organizationId={organizationId}
        onChanged={(removed) => reload(removed)} />
    </section>;
  }

  return <section className={`signalSetup${step === "repositories" ? " signalSetup--repositories" : ""}`}>
    {header}
    <div className="signalIntro"><h2>{headings[step]}</h2><p>{descriptions[step]}</p></div>
    {error && <p className="signalError" role="alert">{error}</p>}
    {failedProvider && !(step === "slack" && failedProvider === "slack") && <p className="signalError" role="alert">
      Could not connect {sourceName(failedProvider)}. Try again{searchParams.get("reason") ? ` (${searchParams.get("reason")})` : ""}.{" "}
      <button type="button" className="signalLinkButton" onClick={() => setSearchParams({}, { replace: true })}>Dismiss</button>
    </p>}

    {step === "telemetry" && <SourceRows sources={telemetrySources} actions={actions} otelServices={otel.count} />}

    {step === "repositories" && <RepositoryPicker repositories={options.repositories} selected={draft.repositoryIds}
      onChange={(repositoryIds) => setDraft({ ...draft, repositoryIds })}
      empty={<><Link to="/signal/setup/code">Connect GitHub</Link> to select repositories.</>} />}

    {step === "slack" && <FindingsDestinationPicker choice={destination} onChoose={setDestination}
      actions={actions} options={options} onOptions={setOptions} draft={draft} onDraft={setDraft}
      slackFailure={failedProvider === "slack" ? slackSignInProblem(searchParams.get("reason")) : null}
      // Saved at once, since Signal checks the URL with a post. Choices made
      // while it was checking are kept: they are read from the latest edit.
      onDiscordSaved={(saved) => {
        setSettings(saved, true);
        setEdit((previous) => ({
          base: saved,
          draft: { ...(previous?.base === settings ? previous.draft : settings), discord: saved.discord, delivery: saved.delivery },
        }));
      }} />}

    {step === "context" && <>
      <SourceRows sources={contextSources} actions={actions} otelServices={otel.count} />
      <div className="signalSettingsCard signalSettingsCard--rows">
        <SettingsRow label={slackScanLabel} description="Signal skips problems your team already discussed in the channels you choose.">
          <SlackScanSwitch checked={draft.slackScan.enabled}
            onChange={(enabled) => setDraft({ ...draft, slackScan: { ...draft.slackScan, enabled } })} />
        </SettingsRow>
        {draft.slackScan.enabled && <div className="signalSlackChannels">
          <SlackChannelChecklist options={options} value={draft.slackScan.channels}
            onChange={(channels) => setDraft({ ...draft, slackScan: { ...draft.slackScan, channels } })} />
        </div>}
      </div>
    </>}

    {step === "plan" && <SignalPlanStep settings={settings} destinationChosen={findingsDestinationChosen(draft)} saving={saving}
      onBack={() => go("context")}
      onTurnOn={() => save({ ...draft, enabled: true }, "findings")}
      onTurnOff={() => save({ ...draft, enabled: false })} />}

    {step !== "plan" && <footer className={`signalSetupActions${step === "code" ? " signalSetupActions--inline" : ""}`}>
      {index > 0 ? <Button onClick={() => go(steps[index - 1]!)}>Back</Button> : <span />}
      {step === "code" && !actions.connected("github")
        // Without GitHub, Signal explains problems from telemetry alone.
        ? <div className="signalSetupChoice">
          <Button onClick={() => go("slack")}>Skip for now</Button>
          <Button className="signalGithubButton" variant="primary" disabled={!actions.summary("github")?.connectUrl} onClick={() => actions.connect("github")}><SignalLogo provider="github" />Connect GitHub</Button>
        </div>
        : step === "repositories" ? <Button variant={draft.repositoryIds.length ? "primary" : "secondary"} disabled={saving} onClick={() => void save(draft, "slack")}>
          {draft.repositoryIds.length ? "Continue" : "Skip for now"}
        </Button>
        : step === "slack" ? <DestinationContinue blocker={destinationBlocker(destination, draft, actions.connected("slack"))} saving={saving}
          // Only the chosen destination is kept, so findings go where the person picked.
          onContinue={() => void continueFromDestination()} />
        : step === "context" ? <ContextContinue draft={draft} saving={saving}
          anyConnected={contextSources.some((source) => actions.connected(source.provider))}
          onContinue={() => void save(draft, "plan")} />
        : <Button variant="primary" onClick={() => go(steps[index + 1]!)}>Continue</Button>}
    </footer>}

  </section>;
}

// Continue, with the reason it is disabled beside it.
function DestinationContinue({ blocker, saving, onContinue }: { blocker: string | null; saving: boolean; onContinue: () => void }) {
  return <div className="signalSetupChoice">
    {blocker && <span className="signalSetupHint">{blocker}</span>}
    <Button variant="primary" disabled={saving || blocker !== null} onClick={onContinue}>Continue</Button>
  </div>;
}

function ContextContinue({ draft, saving, anyConnected, onContinue }: {
  draft: SignalSettings; saving: boolean; anyConnected: boolean; onContinue: () => void;
}) {
  const skipping = !anyConnected && !draft.slackScan.enabled;
  return <Button variant={skipping ? "secondary" : "primary"} disabled={saving || !slackScanReady(draft.slackScan)} onClick={onContinue}>
    {skipping ? "Skip for now" : "Continue"}
  </Button>;
}
