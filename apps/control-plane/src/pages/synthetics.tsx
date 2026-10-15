import { CaretRightIcon, GlobeIcon, PlusIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { relativeTime } from "../agents-api";
import { AppShell } from "../components/app-shell";
import { SyntheticStatusBadge, UptimeStrip } from "../components/synthetics";
import { Badge, DataTable } from "../design-system";
import { fetchSyntheticChecks, formatUptime, spanLabel, type SyntheticCheckSummary } from "../synthetics-api";
import { formatDuration } from "../telemetry-api";
import { useDocumentTitle } from "../use-document-title";
import "../components/automation-run-history.css";
import "../components/synthetics.css";

function CheckStatus({ check }: { check: SyntheticCheckSummary }) {
  if (!check.enabled) return <Badge>Off</Badge>;
  if (!check.lastStatus) return <Badge>Not run yet</Badge>;
  return <SyntheticStatusBadge status={check.lastStatus} />;
}

// "Up for 3 days" or "Down for 5 minutes", from when the status last changed.
function streak(check: SyntheticCheckSummary): string {
  if (!check.enabled || !check.lastStatus || !check.statusSince) return "—";
  const span = spanLabel(Date.now() - Date.parse(check.statusSince));
  return check.lastStatus === "failed" ? `Down for ${span}` : `Up for ${span}`;
}

export function SyntheticsPage() {
  useDocumentTitle("Synthetic checks");
  const navigate = useNavigate();
  // Undefined while loading; null when the workspace cannot use checks.
  const [checks, setChecks] = useState<SyntheticCheckSummary[] | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setChecks(await fetchSyntheticChecks());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load synthetic checks");
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(load);
    // The list shows each check's latest runs, so it is refreshed while open.
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const newCheck = (
    <Link className="dsButton dsButton--primary dsButton--small" to="/synthetics/new">
      <PlusIcon size={12} />New check
    </Link>
  );

  return (
    <AppShell active="synthetics" redesigned>
      <header className="workspaceHeading">
        <h1><GlobeIcon aria-hidden="true" size={16} weight="bold" />Synthetic checks</h1>
        {checks && checks.length > 0 ? <div className="workspaceHeading__actions">{newCheck}</div> : null}
      </header>
      {checks === undefined ? (
        error ? (
          <div className="automationRuns__message" role="alert">
            <p>{error}</p>
            <button onClick={() => void load()} type="button">Retry</button>
          </div>
        ) : (
          <p className="telemetryPage__status">Loading…</p>
        )
      ) : checks === null ? (
        <section className="emptyState emptyState--list">
          <h2>Synthetic checks are not available</h2>
          <p>This workspace cannot use synthetic checks yet.</p>
        </section>
      ) : checks.length === 0 ? (
        <section className="emptyState emptyState--list">
          <h2>No synthetic checks yet</h2>
          <p>Request your endpoints on a schedule, check the responses, and get a Slack message when they fail.</p>
          {newCheck}
        </section>
      ) : (
        <section aria-label="Synthetic checks" className="automationRuns agentListTable">
          <DataTable<SyntheticCheckSummary>
            aria-label="Synthetic checks"
            columns={[
              {
                header: "Check",
                key: "name",
                render: (check) => (
                  <span className="agentTableTitle">
                    <Link to={`/synthetics/${check.id}`}><strong>{check.name}</strong></Link>
                    <small className="syntheticsTable__url">{check.method} {check.url}</small>
                  </span>
                ),
              },
              {
                header: "Status",
                key: "status",
                render: (check) => <CheckStatus check={check} />,
                width: "120px",
              },
              {
                header: "Latest runs",
                key: "recent",
                render: (check) =>
                  check.recent.length > 0 ? (
                    <UptimeStrip label={`Latest ${check.recent.length} runs`} segments={check.recent.map((status) => ({ status }))} small />
                  ) : (
                    <span className="agentTableCell">—</span>
                  ),
                width: "176px",
              },
              {
                header: "Uptime (24h)",
                key: "uptime",
                render: (check) => <span className="agentTableCell syntheticsTable__number">{formatUptime(check.uptime)}</span>,
                width: "110px",
              },
              {
                header: "Avg. duration",
                key: "duration",
                render: (check) => (
                  <span className="agentTableCell syntheticsTable__number">
                    {check.averageDurationMs === null ? "—" : formatDuration(check.averageDurationMs)}
                  </span>
                ),
                width: "110px",
              },
              {
                header: "Last run",
                key: "lastRun",
                render: (check) =>
                  check.lastRunAt ? (
                    <time className="agentTableCell" dateTime={check.lastRunAt} title={`${streak(check)} · ${new Date(check.lastRunAt).toLocaleString()}`}>
                      {relativeTime(check.lastRunAt)}
                    </time>
                  ) : (
                    <span className="agentTableCell">—</span>
                  ),
                width: "100px",
              },
              {
                header: "",
                key: "open",
                render: () => <CaretRightIcon aria-hidden="true" className="automationRuns__open" size={14} />,
                width: "44px",
              },
            ]}
            getRowKey={(check) => check.id}
            onRowClick={(check) => navigate(`/synthetics/${check.id}`)}
            rows={checks}
            variant="workspace"
          />
        </section>
      )}
    </AppShell>
  );
}
