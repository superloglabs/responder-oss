import { useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { IconCheck, IconSearch } from "@tabler/icons-react";
import { Button } from "../design-system";
import { useDocumentTitle } from "../use-document-title";
import { useSignalPreview } from "./model";
import { ConnectionRow, SignalDialog, SignalLogo } from "./shared";

const telemetry = [
  { provider: "datadog", name: "Datadog", description: "80% data completeness" },
  { provider: "sentry", name: "Sentry", description: "90% data completeness" },
  { provider: "grafana", name: "Grafana", description: "80% data completeness" },
  { provider: "otel", name: "OpenTelemetry", description: "100% data completeness" },
  { provider: "aws", name: "AWS CloudWatch", description: "90% data completeness" },
];
const context = [
  { provider: "linear", name: "Linear", description: "Issues, priorities, and work already in progress" },
  { provider: "jira", name: "Jira", description: "Tickets, project history, and known issues" },
  { provider: "posthog", name: "PostHog", description: "Product usage and customer impact" },
  { provider: "aws-context", name: "AWS", description: "Infrastructure and resource context" },
  { provider: "gcp", name: "Google Cloud", description: "Infrastructure and resource context" },
];
const steps = ["telemetry", "code", "repositories", "slack", "context", "plan"] as const;
const headings = ["Connect your telemetry", "Connect your GitHub organization", "Select your repositories", "Connect Slack", "Add more context", "Choose your plan"];
const descriptions = [
  "Signal investigates your telemetry and sends issues with real impact to Slack.",
  "Connect GitHub to choose the repositories Signal can use.",
  "Choose which repositories in acme Signal can use to investigate issues.",
  "Choose where Signal sends findings.",
  "Help Signal understand your work and its impact.",
  "Start a monthly subscription to receive investigated findings in Slack.",
];
const repositories = ["acme / api", "acme / web", "acme / infrastructure"];

export function SignalSetup() {
  const { step = "telemetry" } = useParams();
  const index = steps.findIndex((candidate) => candidate === step);
  useDocumentTitle("Signal · Setup");
  const navigate = useNavigate();
  const { preview, setPreview } = useSignalPreview();
  const [search, setSearch] = useState("");
  const [managing, setManaging] = useState<{ provider: string; name: string } | null>(null);
  const [plan, setPlan] = useState<"Pro" | "Max" | null>(null);
  const connected = (provider: string) => preview.connections.includes(provider);
  const connect = (provider: string) => setPreview((state) => ({
    ...state, connections: [...new Set([...state.connections, provider])],
  }));
  if (index < 0) return <Navigate replace to="/signal/setup" />;

  function rows(sources: typeof telemetry, className = "") {
    return <div className={`signalConnections ${className}`}>{sources.map((source) => <ConnectionRow key={source.provider}
      {...source} provider={source.provider === "aws-context" ? "aws" : source.provider}
      connected={connected(source.provider)} onConnect={() => connect(source.provider)}
      onManage={() => setManaging(source)} />)}</div>;
  }
  const canContinue = index === 0 ? telemetry.some((source) => connected(source.provider))
    : index === 2 ? connected("github") && preview.repositories.length > 0
    : index === 3 ? connected("slack") && Boolean(preview.channel) : true;
  return <section className={`signalSetup${index === 2 ? " signalSetup--repositories" : ""}`}>
    <header className="signalWelcome"><h1>Welcome to Signal</h1><p>Step {[1, 2, 2, 3, 4, 5][index]} out of 5</p></header>
    <div className="signalIntro"><h2>{headings[index]}</h2><p>{descriptions[index]}</p></div>
    {index === 0 && rows(telemetry, "signalTelemetry signalConnections--compact")}
    {index === 2 && <div className="signalRepositories">
      <div className="signalRepoSearch"><label className="signalSearch"><IconSearch size={14} /><input aria-label="Search repositories" placeholder="Search repositories…" value={search} onChange={(e) => setSearch(e.target.value)} /></label><span>{preview.repositories.length} selected</span></div>
      <div className="signalRepoList">
      {repositories.filter((repo) => repo.toLowerCase().includes(search.toLowerCase())).map((repo) => <label className="signalRepoRow" key={repo}>
        <span className="signalRepoCheckbox"><input type="checkbox" disabled={!connected("github")} checked={preview.repositories.includes(repo)} onChange={(e) => setPreview((state) => ({ ...state, repositories: e.target.checked ? [...state.repositories, repo] : state.repositories.filter((r) => r !== repo) }))} /><IconCheck aria-hidden="true" size={12} /></span>
        <span>{repo}</span>
      </label>)}
      {!repositories.some((repo) => repo.toLowerCase().includes(search.toLowerCase())) && <p className="signalEmpty">No repositories match “{search}”.</p>}
      {!connected("github") && <p className="signalEmpty"><Link to="/signal/setup/code">Connect GitHub</Link> to select repositories.</p>}
      </div>
    </div>}
    {index === 3 && <div className="signalConnections signalSlack">
      <ConnectionRow provider="slack" name="Slack" description={connected("slack") ? "Acme" : "Connect your workspace"}
        connected={connected("slack")} onConnect={() => connect("slack")} onManage={() => setManaging({ provider: "slack", name: "Slack" })} connectedActionLabel="Change workspace" />
      <div className="signalSlackFields"><div className="signalField">
        <label htmlFor="signal-findings-channel"><strong>Findings channel</strong><span>Issues that need your attention.</span></label>
        <select id="signal-findings-channel" aria-label="Findings channel" disabled={!connected("slack")} value={preview.channel} onChange={(e) => setPreview((state) => ({ ...state, channel: e.target.value }))}>
          <option value="signal-findings"># signal-findings</option><option value="engineering"># engineering</option><option value="incidents"># incidents</option>
        </select>
      </div></div>
    </div>}
    {index === 4 && rows(context, "signalConnections--compact signalContext")}
    {index === 5 && <div className="signalPlans">{(["Pro", "Max"] as const).map((name) => <section className="signalPlan" key={name}>
      <h3>{name}</h3><p className="signalPlanPrice">${name === "Pro" ? "100" : "200"}<span> / month</span></p>
      <p><IconCheck size={14} />Up to {name === "Pro" ? "50" : "100"} investigated findings</p><p><IconCheck size={14} />$2 per finding</p>
      <Button variant="primary" onClick={() => setPlan(name)}>{preview.plan === name ? "Selected · " : ""}Choose {name} (${name === "Pro" ? "100" : "200"})</Button>
    </section>)}</div>}
    <footer className={`signalSetupActions${index === 1 ? " signalSetupActions--inline" : ""}`}>
      {index > 0 ? <Button onClick={() => navigate(`/signal/setup/${steps[index - 1]}`)}>Back</Button> : <span />}
      {index === 1 ? <Button className="signalGithubButton" variant="primary" onClick={() => { connect("github"); navigate("/signal/setup/repositories"); }}><SignalLogo provider="github" />Connect GitHub</Button>
        : index < 5 && <Button variant={index === 4 ? "secondary" : "primary"} disabled={!canContinue} onClick={() => navigate(`/signal/setup/${steps[index + 1]}`)}>
          {index === 4 && !context.some((source) => connected(source.provider)) ? "Skip for now" : "Continue"}
        </Button>}
    </footer>
    {managing && <SignalDialog title={`Manage ${managing.name}`} onClose={() => setManaging(null)}>
      <p>This connection is simulated in the preview.</p>
      <div className="signalDialogActions"><Button onClick={() => setManaging(null)}>Done</Button><Button onClick={() => {
        setPreview((state) => ({ ...state, connections: state.connections.filter((p) => p !== managing.provider), ...(managing.provider === "github" ? { repositories: [] } : {}) }));
        setManaging(null);
      }}>Disconnect {managing.name}</Button></div>
    </SignalDialog>}
    {plan && <SignalDialog title={`Try ${plan} in this preview`} onClose={() => setPlan(null)}>
      <p>{plan === "Pro" ? "50 findings for $100" : "100 findings for $200"} per month. This preview does not collect payment details or start a subscription.</p>
      <div className="signalDialogActions"><Button onClick={() => setPlan(null)}>Back</Button><Button variant="primary" onClick={() => {
        setPreview((state) => ({ ...state, plan })); setPlan(null); navigate("/signal/findings");
      }}>View sample findings</Button></div>
    </SignalDialog>}
  </section>;
}

