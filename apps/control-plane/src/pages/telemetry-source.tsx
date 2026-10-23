import { CodeIcon } from "@phosphor-icons/react";
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { relativeTime } from "../agents-api";
import { AppShell } from "../components/app-shell";
import { TelemetrySourceSkeleton } from "../components/screen-skeletons";
import { ProviderGlyph } from "../components/icons";
import { ScrambleText } from "../components/scramble-text";
import { useIntegrationConnect } from "../components/use-integration-connect";
import { copyToClipboard } from "../copy-to-clipboard";
import { Badge, Button, CodeBlock, DataTable, SelectField } from "../design-system";
import {
  createIngestKey,
  defaultIngestKeyName,
  fetchIngestKeys,
  openTelemetryPrompt,
} from "../ingest-keys-api";
import {
  type AwsStackLaunch,
  awsRegions,
  awsTelemetryTemplatePath,
  connectGcpSource,
  connectVercelSource,
  createAwsStack,
  fetchTelemetrySources,
  removeTelemetrySource,
  sourceHealth,
  type TelemetrySourceOverview,
  type TelemetrySourceSummary,
} from "../telemetry-sources-api";
import { telemetrySourceOption } from "../telemetry-source-options";
import { useDocumentTitle } from "../use-document-title";
import { useScrambledText } from "../use-scrambled-text";
import "../components/automation-run-history.css";
import "../components/telemetry.css";

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

// One way of sending telemetry: the OpenTelemetry SDK, or a cloud provider.
export function TelemetrySourcePage() {
  const { source } = useParams();
  const option = telemetrySourceOption(source);
  useDocumentTitle(option ? `Add telemetry · ${option.title}` : "Add telemetry");
  if (!option) return <Navigate replace to="/telemetry/setup" />;
  return (
    <AppShell active="telemetry-overview" redesigned>
      <header className="workspaceHeading">
        <h1>
          {option.id === "opentelemetry" ? (
            <CodeIcon aria-hidden="true" size={16} weight="bold" />
          ) : (
            <ProviderGlyph decorative provider={option.id} />
          )}
          {option.title}
        </h1>
      </header>
      <div className="telemetrySetup">
        <Link className="telemetrySetup__back" to="/telemetry/setup">← Add telemetry</Link>
        {option.id === "opentelemetry" ? <OpenTelemetrySetup /> : <CloudSourceSetup provider={option.id} />}
      </div>
    </AppShell>
  );
}

function OpenTelemetrySetup() {
  // Undefined while loading; false when the cell does not accept telemetry.
  const [available, setAvailable] = useState<boolean | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      setAvailable((await fetchIngestKeys()) !== null);
    } catch (cause) {
      setError(errorText(cause, "Unable to load ingest keys"));
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  async function create() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      setToken((await createIngestKey({ name: defaultIngestKeyName() })).token);
    } catch (cause) {
      setError(errorText(cause, "Unable to create the key"));
    } finally {
      setSaving(false);
    }
  }

  // The key stays in the field, so it can be copied by hand when the clipboard is unavailable.
  async function copyKey(value: string) {
    setError(null);
    try {
      await copyToClipboard(value);
    } catch {
      setError("Unable to copy. Select the key and copy it manually.");
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  if (available === undefined) {
    return error ? <RetryMessage message={error} onRetry={() => { setError(null); void load(); }} /> : <TelemetrySourceSkeleton />;
  }
  if (!available) return <Unavailable />;
  return (
    <>
      <p className="telemetrySetup__intro">
        Instrument your app with the OpenTelemetry SDK for its language. It sends logs, traces and metrics over
        OTLP/HTTP with an ingest key.
      </p>
      {token ? (
        <>
          <section aria-labelledby="otel-key-title" className="telemetrySetup__section">
            <h2 id="otel-key-title">Your ingest key</h2>
            <div className="telemetrySetup__keyControls">
              <CreatedKeyField token={token} />
              <Button onClick={() => void copyKey(token)} variant="secondary">
                <ScrambleText text={copied ? "Copied" : "Copy key"} />
              </Button>
            </div>
            {error ? <p className="formError" role="alert">{error}</p> : null}
            <p className="telemetrySetup__note">
              You can see this key only once. Manage keys in <Link to="/settings/ingest-keys">Settings → Ingest keys</Link>.
            </p>
          </section>
          <section aria-labelledby="otel-prompt-title" className="telemetrySetup__section">
            <h2 id="otel-prompt-title">Paste this prompt into your coding agent</h2>
            <p>
              Claude Code, Cursor, Codex or any other agent adds the SDK, instruments the app and connects its logger.
              The prompt contains your key.
            </p>
            <CodeBlock code={openTelemetryPrompt(window.location.origin, token)} language="prompt" />
          </section>
        </>
      ) : (
        <section aria-label="Create an ingest key" className="telemetrySetup__section telemetrySetup__create">
          <Button loading={saving} onClick={() => void create()} variant="primary">Create ingest key</Button>
          {error ? <p className="formError" role="alert">{error}</p> : null}
          <p className="telemetrySetup__note">You get the key and a setup prompt for your coding agent.</p>
        </section>
      )}
    </>
  );
}

// The new key is revealed from behind symbols when it appears. Copying always uses the real key.
function CreatedKeyField({ token }: { token: string }) {
  const shown = useScrambledText(token, true);
  return <input aria-label="New ingest key" readOnly value={shown} />;
}

function CloudSourceSetup({ provider }: { provider: "aws" | "gcp" | "vercel" }) {
  // Undefined while loading; null when the cell does not accept telemetry.
  const [overview, setOverview] = useState<TelemetrySourceOverview | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await fetchTelemetrySources();
      setOverview(next);
      return next;
    } catch (cause) {
      setError(errorText(cause, "Unable to load telemetry sources"));
      return undefined;
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  if (overview === undefined) {
    return error ? <RetryMessage message={error} onRetry={() => { setError(null); void load(); }} /> : <TelemetrySourceSkeleton />;
  }
  if (overview === null) return <Unavailable />;
  const sources = overview.sources.filter((source) => source.provider === provider);
  const list = <SourceList onChanged={load} sources={sources} />;
  if (provider === "aws") return <AwsSetup list={list} onCreated={load} />;
  const accounts = overview.accounts.filter((account) => account.provider === provider);
  return provider === "vercel" ? (
    <VercelSetup accounts={accounts} configured={overview.providers.vercel} list={list} reload={load} />
  ) : (
    <GcpSetup accounts={accounts} configured={overview.providers.gcp} list={list} onCreated={load} />
  );
}

type Account = TelemetrySourceOverview["accounts"][number];

function AccountForm({
  accounts,
  action,
  label,
  onSubmit,
}: {
  accounts: Account[];
  action: string;
  label: string;
  onSubmit: (integrationAccountId: string) => Promise<unknown>;
}) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = accounts.some((account) => account.id === accountId) ? accountId : (accounts[0]?.id ?? "");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving || !selected) return;
    setSaving(true);
    setError(null);
    try {
      await onSubmit(selected);
    } catch (cause) {
      setError(errorText(cause, "Unable to add the source"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <form className="telemetrySetup__form" onSubmit={(event) => void submit(event)}>
        {accounts.length > 1 ? (
          <SelectField
            label={label}
            onChange={setAccountId}
            options={accounts.map((account) => ({ label: account.displayName, value: account.id }))}
            value={selected}
          />
        ) : (
          <p className="telemetrySetup__intro">{label}: <strong>{accounts[0]?.displayName}</strong></p>
        )}
        <Button loading={saving} type="submit" variant="primary">{action}</Button>
      </form>
      {error ? <p className="formError" role="alert">{error}</p> : null}
    </>
  );
}

function VercelSetup({
  accounts,
  configured,
  list,
  reload,
}: {
  accounts: Account[];
  configured: boolean;
  list: ReactNode;
  reload: () => Promise<TelemetrySourceOverview | null | undefined>;
}) {
  const { connect, connecting, error } = useIntegrationConnect("vercel", "Vercel", async () => {
    const next = await reload();
    return Boolean(next?.accounts.some((account) => account.provider === "vercel"));
  });
  return (
    <>
      <p className="telemetrySetup__intro">
        Superlog creates a trace drain and a log drain on your Vercel team. Traces arrive as OpenTelemetry and
        logs carry their request and trace IDs. Drains need a Pro or Enterprise team.
      </p>
      <section aria-labelledby="vercel-connect-title" className="telemetrySetup__section">
        <h2 id="vercel-connect-title">Create drains</h2>
        {!configured ? (
          <p>Vercel connections are not configured for this installation.</p>
        ) : accounts.length === 0 ? (
          <>
            <p>Connect Vercel first. The drains cover the projects you share with the Superlog integration.</p>
            <div className="telemetrySetup__actions">
              <Button loading={connecting} onClick={() => void connect()} variant="primary">Connect Vercel</Button>
            </div>
            {error ? <p className="formError" role="alert">{error}</p> : null}
          </>
        ) : (
          <AccountForm
            accounts={accounts}
            action="Create drains"
            label="Vercel installation"
            onSubmit={async (id) => { await connectVercelSource(id); await reload(); }}
          />
        )}
      </section>
      {list}
    </>
  );
}

function GcpSetup({
  accounts,
  configured,
  list,
  onCreated,
}: {
  accounts: Account[];
  configured: boolean;
  list: ReactNode;
  onCreated: () => Promise<unknown>;
}) {
  return (
    <>
      <p className="telemetrySetup__intro">
        Superlog reads the project's Cloud Logging entries every minute and its Cloud Run, Compute Engine, Cloud
        SQL, load balancer and Pub/Sub metrics every five minutes. It uses the project's read-only Superlog
        identity, so nothing is installed. Data Access audit logs are skipped.
      </p>
      <section aria-labelledby="gcp-connect-title" className="telemetrySetup__section">
        <h2 id="gcp-connect-title">Read a project</h2>
        {!configured ? (
          <p>Google Cloud connections are not configured for this installation.</p>
        ) : accounts.length === 0 ? (
          <>
            <p>Connect a Google Cloud project in Integrations first, then come back here.</p>
            <div className="telemetrySetup__actions">
              <Link className="dsButton dsButton--primary dsButton--small" to="/settings">Open Integrations</Link>
            </div>
          </>
        ) : (
          <AccountForm
            accounts={accounts}
            action="Start reading"
            label="Google Cloud project"
            onSubmit={async (id) => { await connectGcpSource(id); await onCreated(); }}
          />
        )}
      </section>
      {list}
    </>
  );
}

function AwsSetup({ list, onCreated }: { list: ReactNode; onCreated: () => Promise<unknown> }) {
  const [region, setRegion] = useState<string>("us-east-1");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [launch, setLaunch] = useState<(AwsStackLaunch & { region: string }) | null>(null);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      setLaunch({ ...(await createAwsStack(region)), region });
      await onCreated();
    } catch (cause) {
      setError(errorText(cause, "Unable to prepare the stack"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <p className="telemetrySetup__intro">
        A CloudFormation stack in your account streams one region's CloudWatch metrics and CloudWatch Logs to
        Superlog through Amazon Data Firehose. Metric Streams, Firehose and log delivery are billed to your AWS
        account. Deploy one stack per region.
      </p>
      <section aria-labelledby="aws-stack-title" className="telemetrySetup__section">
        <h2 id="aws-stack-title">Deploy the stack</h2>
        <form className="telemetrySetup__form" onSubmit={(event) => void create(event)}>
          <SelectField
            label="Region"
            onChange={setRegion}
            options={awsRegions.map((value) => ({ label: value, value }))}
            searchable
            value={region}
          />
          <Button loading={saving} type="submit" variant="primary">Create stack link</Button>
        </form>
        {error ? <p className="formError" role="alert">{error}</p> : null}
        {launch ? (
          <div className="telemetrySetup__created">
            <h2>Stack {launch.stackName} in {launch.region}</h2>
            <p>The link and command contain a new ingest key. Copy them now; they are not shown again.</p>
            {launch.launchUrl ? (
              <div className="telemetrySetup__actions">
                <a className="dsButton dsButton--primary dsButton--small" href={launch.launchUrl} rel="noreferrer" target="_blank">
                  Open in the AWS console
                </a>
              </div>
            ) : null}
            <p>
              Or <a download href={awsTelemetryTemplatePath}>download the template</a> and deploy it with the AWS CLI:
            </p>
            <CodeBlock code={launch.deployCommand} language="bash" />
          </div>
        ) : null}
      </section>
      {list}
    </>
  );
}

function SourceList({ onChanged, sources }: { onChanged: () => Promise<unknown>; sources: TelemetrySourceSummary[] }) {
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  async function remove(source: TelemetrySourceSummary) {
    setError(null);
    setRemoving(source.id);
    try {
      await removeTelemetrySource(source.id);
      await onChanged();
    } catch (cause) {
      setError(errorText(cause, "Unable to remove the source"));
    } finally {
      setRemoving(null);
    }
  }

  if (sources.length === 0) return null;
  return (
    <section aria-labelledby="sources-title" className="telemetrySetup__section">
      <h2 id="sources-title">Connected</h2>
      {error ? <p className="formError" role="alert">{error}</p> : null}
      <div className="agentListTable">
        <DataTable<TelemetrySourceSummary>
          aria-label="Connected sources"
          columns={[
            {
              header: "Source",
              key: "name",
              render: (source) => (
                <span className="agentTableTitle">
                  <strong>{source.displayName}</strong>
                  <small>
                    {[source.provider === "aws" ? "Delete the stack in CloudFormation to stop streaming" : null, source.lastError]
                      .filter(Boolean)
                      .join(" · ")}
                  </small>
                </span>
              ),
            },
            {
              header: "Status",
              key: "status",
              render: (source) => {
                const health = sourceHealth(source);
                return <Badge tone={health.tone}>{health.label}</Badge>;
              },
              width: "170px",
            },
            {
              header: "Last data",
              key: "received",
              render: (source) => (
                <span className="agentTableCell">{source.lastReceivedAt ? relativeTime(source.lastReceivedAt) : "Never"}</span>
              ),
              width: "110px",
            },
            {
              header: "",
              key: "remove",
              render: (source) => (
                <Button loading={removing === source.id} onClick={() => void remove(source)} size="small" variant="ghost">
                  Remove
                </Button>
              ),
              width: "100px",
            },
          ]}
          getRowKey={(source) => source.id}
          rows={sources}
          variant="workspace"
        />
      </div>
    </section>
  );
}

function RetryMessage({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="automationRuns__message" role="alert">
      <p>{message}</p>
      <button onClick={onRetry} type="button">Retry</button>
    </div>
  );
}

function Unavailable() {
  return (
    <section className="emptyState emptyState--list">
      <h2>Sending telemetry is not available</h2>
      <p>This workspace cannot receive telemetry in this region yet.</p>
    </section>
  );
}
