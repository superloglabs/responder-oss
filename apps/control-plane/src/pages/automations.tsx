import { DotsThreeIcon, PlayPauseIcon, PlusIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  fetchAutomations,
  runAutomation,
  setAutomationEnabled,
  type AutomationListItem,
} from "../automations-api";
import { relativeTime } from "../agents-api";
import { AppShell } from "../components/app-shell";
import { AutomationListSkeleton } from "../components/screen-skeletons";
import { AutomationTemplateGallery } from "../components/automation-template-gallery";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { Badge, DataTable, IconButton } from "../design-system";
import { useDocumentTitle } from "../use-document-title";
import {
  connectorNames,
  connectorSummary,
  runStatusLabels,
  triggerEventLabel,
  triggerProviderLabel,
} from "./automation-list-presentation";
import "./automations.css";

function AutomationActions({
  automation,
  onChanged,
  onError,
}: {
  automation: AutomationListItem;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  async function act(action: () => Promise<unknown>, failure: string) {
    setBusy(true);
    try {
      await action();
      await onChanged();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : failure);
    } finally {
      setBusy(false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton
          aria-label={`Actions for ${automation.name}`}
          disabled={busy}
          size="small"
          variant="ghost"
        >
          <DotsThreeIcon size={16} weight="bold" />
        </IconButton>
      </DropdownMenuTrigger>
      {/* React events bubble through the portal; keep menu clicks from opening the row. */}
      <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
        <DropdownMenuItem onSelect={() => navigate(`/automations/${automation.id}`)}>
          View runs
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate(`/automations/${automation.id}/edit`)}>
          Edit
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!automation.enabled}
          onSelect={() => void act(() => runAutomation(automation.id), "Unable to start automation")}
        >
          Run now
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => void act(
            () => setAutomationEnabled(automation.id, !automation.enabled),
            "Unable to update automation",
          )}
        >
          {automation.enabled ? "Pause" : "Resume"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AutomationsPage() {
  const [automations, setAutomations] = useState<AutomationListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  useDocumentTitle("Automations");

  const load = useCallback(async () => {
    setAutomations(await fetchAutomations());
    setError(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchAutomations()
      .then((items) => {
        if (!cancelled) setAutomations(items);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Unable to load automations");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  return (
    <AppShell active="automations" redesigned>
      <header className="workspaceHeading">
        <h1><PlayPauseIcon aria-hidden="true" size={16} weight="fill" />Automations</h1>
        <Link className="dsButton dsButton--primary dsButton--small" to="/automations/new">
          <PlusIcon aria-hidden="true" size={14} />Create automation
        </Link>
      </header>
      {error ? <p className="formError" role="alert">{error}</p> : null}
      {loading ? (
        <AutomationListSkeleton />
      ) : automations.length === 0 ? (
        error ? null : (
          <section className="emptyState emptyState--list automationsEmpty">
            <h2>No automations yet</h2>
            <p>Choose a trigger and a model, and run a coding task in a fresh sandbox.</p>
            <Link className="dsButton dsButton--primary dsButton--medium" to="/automations/new">
              Create an automation
            </Link>
          </section>
        )
      ) : (
        <section aria-label="Automations" className="agentListTable">
          <DataTable<AutomationListItem>
            aria-label="Configured automations"
            variant="workspace"
            columns={[
              {
                header: "Automation",
                key: "automation",
                render: (automation) => (
                  <Link className="agentTableTitle" to={`/automations/${automation.id}`}>
                    <strong>{automation.name}</strong>
                    <small>{automation.description || "No description provided."}</small>
                  </Link>
                ),
                width: "38%",
              },
              {
                header: "Triggers",
                key: "trigger",
                render: (automation) => (
                  <span className="agentTableRun">
                    <span>{triggerProviderLabel(automation.trigger)}</span>
                    <small>{triggerEventLabel(automation.trigger)}</small>
                  </span>
                ),
                width: "19%",
              },
              {
                header: "Connectors",
                key: "connectors",
                render: (automation) => (
                  <span className="agentTableCell" title={connectorNames(automation.connectors) || undefined}>
                    {connectorSummary(automation.connectors)}
                  </span>
                ),
                width: "12%",
              },
              {
                header: "Last run",
                key: "last-run",
                render: (automation) => (
                  <span className="agentTableRun">
                    {automation.lastRun ? (
                      <>
                        <time
                          dateTime={automation.lastRun.createdAt}
                          title={new Date(automation.lastRun.createdAt).toLocaleString()}
                        >
                          {relativeTime(automation.lastRun.createdAt)}
                        </time>
                        <small className={`automationRunStatus automationRunStatus--${automation.lastRun.status}`}>
                          {runStatusLabels[automation.lastRun.status]}
                        </small>
                      </>
                    ) : <span>Never</span>}
                  </span>
                ),
                width: "12%",
              },
              {
                header: "Status",
                key: "status",
                render: (automation) => (
                  <Badge tone={automation.enabled ? "live" : "neutral"}>
                    {automation.enabled ? "Active" : "Paused"}
                  </Badge>
                ),
                width: "13%",
              },
              {
                align: "right",
                header: "",
                key: "actions",
                render: (automation) => (
                  <AutomationActions automation={automation} onChanged={load} onError={setError} />
                ),
                width: "6%",
              },
            ]}
            getRowKey={(automation) => automation.id}
            onRowClick={(automation) => navigate(`/automations/${automation.id}`)}
            rows={automations}
          />
        </section>
      )}
      {loading ? null : <AutomationTemplateGallery />}
    </AppShell>
  );
}
