import { PaperPlaneTiltIcon } from "@phosphor-icons/react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { relativeTime } from "../agents-api";
import { AppShell } from "../components/app-shell";
import { Button, CodeBlock, DataTable, TextField } from "../design-system";
import {
  createIngestKey,
  fetchIngestKeys,
  otlpEnvironment,
  revokeIngestKey,
  type TelemetryIngestKeySummary,
} from "../ingest-keys-api";
import { useDocumentTitle } from "../use-document-title";
import "../components/automation-run-history.css";
import "../components/telemetry.css";

// Creates ingest keys and shows how to point an OpenTelemetry SDK at them.
export function TelemetrySetupPage() {
  useDocumentTitle("Send telemetry");
  // Undefined while loading; null when the cell does not accept telemetry.
  const [keys, setKeys] = useState<TelemetryIngestKeySummary[] | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<{ key: TelemetryIngestKeySummary; token: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setKeys(await fetchIngestKeys());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load ingest keys");
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    if (!name.trim()) {
      setError("Name the key, for example after the app or environment that uses it.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await createIngestKey({ name: name.trim() });
      setCreated(result);
      setName("");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create the key");
    } finally {
      setSaving(false);
    }
  }

  async function revoke(key: TelemetryIngestKeySummary) {
    setError(null);
    try {
      await revokeIngestKey(key.id);
      if (created?.key.id === key.id) setCreated(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to revoke the key");
    }
  }

  return (
    <AppShell active="logs" redesigned>
      <header className="workspaceHeading">
        <h1><PaperPlaneTiltIcon aria-hidden="true" size={16} weight="bold" />Send telemetry</h1>
      </header>
      {keys === undefined ? (
        error ? (
          <div className="automationRuns__message" role="alert">
            <p>{error}</p>
            <button onClick={() => { setError(null); void load(); }} type="button">Retry</button>
          </div>
        ) : (
          <p className="telemetryPage__status">Loading…</p>
        )
      ) : keys === null ? (
        <section className="emptyState emptyState--list">
          <h2>Sending telemetry is not available</h2>
          <p>This workspace cannot receive telemetry in this region yet.</p>
        </section>
      ) : (
        <div className="telemetrySetup">
          <p className="telemetrySetup__intro">
            Send logs, traces and metrics with any OpenTelemetry SDK or collector over OTLP/HTTP. Create a key,
            set these variables where your app runs, and data appears in <Link to="/logs">Logs</Link> and{" "}
            <Link to="/traces">Traces</Link>.
          </p>
          {created ? (
            <section aria-label="New key" className="telemetrySetup__created">
              <h2>Key {created.key.name}</h2>
              <p>Copy it now. It is not shown again.</p>
              <CodeBlock code={otlpEnvironment(window.location.origin, created.token)} language="bash" />
            </section>
          ) : null}
          <form className="telemetrySetup__form" onSubmit={(event) => void create(event)}>
            <TextField label="Key name" maxLength={120} onChange={(event) => setName(event.target.value)} placeholder="checkout-api production" value={name} />
            <Button loading={saving} type="submit" variant="primary">Create key</Button>
          </form>
          {error ? <p className="formError" role="alert">{error}</p> : null}
          {keys.length > 0 ? (
            <section aria-label="Ingest keys" className="agentListTable">
              <DataTable<TelemetryIngestKeySummary>
                aria-label="Ingest keys"
                columns={[
                  {
                    header: "Key",
                    key: "name",
                    render: (key) => (
                      <span className="agentTableTitle">
                        <strong>{key.name}</strong>
                        <small><code>{key.prefix}…</code></small>
                      </span>
                    ),
                  },
                  {
                    header: "Last used",
                    key: "used",
                    render: (key) => <span className="agentTableCell">{key.lastUsedAt ? relativeTime(key.lastUsedAt) : "Never"}</span>,
                    width: "140px",
                  },
                  {
                    header: "",
                    key: "revoke",
                    render: (key) => (
                      <Button onClick={() => void revoke(key)} size="small" variant="ghost">Revoke</Button>
                    ),
                    width: "100px",
                  },
                ]}
                getRowKey={(key) => key.id}
                rows={keys}
                variant="workspace"
              />
            </section>
          ) : null}
        </div>
      )}
    </AppShell>
  );
}
