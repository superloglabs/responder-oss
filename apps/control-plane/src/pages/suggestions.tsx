import { providerDisplayName as sourceLabel } from "../components/provider-glyphs";
import { lazy, Suspense, useEffect, useState } from "react";
import Markdown from "react-markdown";
import { Link, useLocation, useParams } from "react-router-dom";
import {
  createSuggestionPullRequest,
  fetchSuggestion,
  fetchSuggestions,
  relativeTime,
  saveSuggestionSettings,
  setSuggestionDismissed,
  type SuggestionListItem,
  type SuggestionPullRequest,
  type SuggestionSummary,
} from "../agents-api";
import { AppShell } from "../components/app-shell";
import { CaretRightIcon, FlagIcon, GitPullRequestIcon as PullRequestIcon, CheckIcon, ListBulletsIcon } from "@phosphor-icons/react";
import { Button, DataTable, Switch, SelectField } from "../design-system";
import "./scan-suggestions.css";
import { useDocumentTitle } from "../use-document-title";

const RemediationDiff = lazy(() =>
  import("../components/remediation-diff").then((module) => ({
    default: module.RemediationDiff,
  })),
);

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1_000).toISOString();
}

type SuggestionStatus = "open" | "applied" | "dismissed";


const storyboardSuggestions: SuggestionListItem[] = [
  {
    codeChange: {
      changes: [
        {
          repository: "superloglabs/responder-oss",
          diff: `diff --git a/apps/worker/src/monitoring.ts b/apps/worker/src/monitoring.ts
--- a/apps/worker/src/monitoring.ts
+++ b/apps/worker/src/monitoring.ts
@@ -8,1 +8,18 @@
 export const workerHeartbeat = meter.createGauge("responder.worker.heartbeat");
+
+export const queueDepth = meter.createObservableGauge("responder.jobs.depth", {
+  description: "Jobs currently visible to a Responder worker",
+});
+
+export const activeLeaseAge = meter.createObservableGauge(
+  "responder.jobs.oldest_lease_age_seconds",
+  { description: "Age of the oldest active job lease" },
+);
+
+queueDepth.addCallback(async (result) => {
+  for (const row of await readQueueDepth()) {
+    result.observe(row.count, { job_kind: row.kind, state: row.state });
+  }
+});
diff --git a/apps/worker/src/investigate.ts b/apps/worker/src/investigate.ts
--- a/apps/worker/src/investigate.ts
+++ b/apps/worker/src/investigate.ts
@@ -72,1 +72,3 @@
 startWorkerHeartbeat();
+registerQueueDepthMetrics();
+registerActiveLeaseAgeMetric();`,
        },
      ],
      description: "Adds queue depth and oldest active lease age measurements to the worker.",
      id: "worker-queue-visibility-code-change",
      title: "Instrument investigation worker queues",
      type: "code_change",
    },
    createdAt: hoursAgo(1),
    id: "worker-queue-visibility",
    subtitle:
      "Queue saturation currently looks like a generic investigation timeout, which makes capacity failures hard to distinguish from provider errors.",
    title: "Add queue depth and lease age metrics for investigation workers.",
    detail: `## Why this would help

Three recent investigations stalled after a worker had claimed the job but before the first provider call. The current health endpoint confirms that the worker is alive, but it does not show whether work is waiting or whether a lease has gone stale.

Expose two low-cardinality measurements at the worker boundary:

- **Queue depth** split by job kind and state.
- **Oldest active lease age** split by job kind only.

This would let the agent separate a capacity problem from an integration problem before it starts searching provider logs.

## Suggested implementation

Add the measurements beside the existing worker heartbeat. Avoid organization or investigation IDs as metric attributes.

\`\`\`ts
const queueDepth = meter.createObservableGauge("responder.jobs.depth", {
  description: "Jobs currently visible to a Responder worker",
});

const activeLeaseAge = meter.createObservableGauge(
  "responder.jobs.oldest_lease_age_seconds",
  { description: "Age of the oldest active job lease" },
);

queueDepth.addCallback(async (result) => {
  for (const row of await readQueueDepth()) {
    result.observe(row.count, { job_kind: row.kind, state: row.state });
  }
});
\`\`\`

## Validate

1. Enqueue a delayed investigation and confirm the pending gauge increments.
2. Claim the job and confirm the active gauge increments while pending returns to zero.
3. Hold the worker and confirm lease age rises without adding new metric dimensions.
4. Add an alert when lease age remains above 120 seconds for five minutes.`,
  },
  {
    codeChange: {
      changes: [
        {
          repository: "superloglabs/responder-oss",
          diff: `diff --git a/apps/worker/src/datadog.ts b/apps/worker/src/datadog.ts
--- a/apps/worker/src/datadog.ts
+++ b/apps/worker/src/datadog.ts
@@ -25,4 +25,5 @@ export interface ProviderError {
   message: string;
   retryable: boolean;
   statusCode?: number;
+  requestId?: string;
 }
diff --git a/apps/worker/src/investigate.ts b/apps/worker/src/investigate.ts
--- a/apps/worker/src/investigate.ts
+++ b/apps/worker/src/investigate.ts
@@ -118,6 +118,7 @@ function logProviderError(error: ProviderError) {
     event: "provider_request_failed",
     provider,
+    requestId: error.requestId,
     retryable: error.retryable,
     statusCode: error.statusCode,
   });`,
        },
      ],
      description: "Carries provider request IDs into the existing structured error event.",
      id: "provider-request-ids-code-change",
      title: "Log upstream provider request IDs",
      type: "code_change",
    },
    createdAt: hoursAgo(4),
    id: "provider-request-ids",
    subtitle:
      "Provider failures lose their upstream request IDs before they reach structured logs, slowing correlation with vendor support and traces.",
    title: "Preserve provider request IDs in structured error logs.",
    detail: `## Why this would help

The provider client receives a request ID on failed responses, but the investigation error boundary records only the status code and message. Recent investigations had to infer the matching vendor request from timestamps.

## Suggested implementation

Extend the normalized provider error with an optional \`requestId\` and include it in the existing structured event.

\`\`\`ts
logger.error({
  event: "provider_request_failed",
  provider,
  requestId: error.requestId,
  statusCode: error.statusCode,
  retryable: error.retryable,
});
\`\`\`

Keep tokens, response bodies, and full URLs out of the log record.

## Validate

- Cover headers with different casing in the provider adapter test.
- Confirm a missing request ID does not change the event shape unexpectedly.
- Trigger a safe failed request locally and correlate the log with its trace span.`,
  },
  {
    codeChange: null,
    createdAt: hoursAgo(28),
    id: "mcp-correlation",
    subtitle:
      "Tool calls and their results are recorded as separate events without a durable correlation field across retries.",
    title: "Carry one correlation ID through every MCP tool-call retry.",
    detail: `## Why this would help

When a tool call is retried, the trace contains multiple requests and results with similar timestamps. A stable correlation ID would let the agent reconstruct the complete attempt sequence without guessing.

## Proposed shape

Generate the ID before the first attempt and attach it to request, result, retry, and terminal error events.

\`\`\`ts
const correlationId = crypto.randomUUID();

await trace.record("tool.requested", {
  correlationId,
  toolName,
  attempt,
});
\`\`\`

## Open question

Confirm whether the correlation ID should remain stable when the model changes the tool input between attempts. The safer default is a new ID for materially different input and the same ID for transport-level retries.`,
  },
  {
    codeChange: null,
    createdAt: hoursAgo(72),
    id: "slack-session-staleness",
    subtitle:
      "A Slack investigation can wait indefinitely after delivery succeeds but session processing stops, with no dedicated alert for that state.",
    title: "Alert when a Slack investigation session stops progressing.",
    detail: `## Why this would help

The delivery webhook and investigation worker have separate health signals. A successful delivery can therefore mask a session that never advances to its next turn.

## Suggested signal

Emit a session progress timestamp and alert when an active session has not advanced for five minutes. Group alerts by workspace and agent, not by session, to keep cardinality bounded.

## Validate

Use a synthetic session to pause processing after delivery. The alert should open once, link to the oldest affected session, and resolve automatically after progress resumes.`,
  },
];

export function SuggestionsPage() {
  const { suggestionId } = useParams();
  const location = useLocation();
  const isStoryboard = location.pathname.startsWith("/_storyboards/");
  const basePath = isStoryboard ? "/_storyboards/suggestions" : "/suggestions";
  const [suggestions, setSuggestions] = useState<SuggestionSummary[]>(
    isStoryboard
      ? storyboardSuggestions.map((suggestion) => ({
          id: suggestion.id,
          title: suggestion.title,
          subtitle: suggestion.subtitle,
          createdAt: suggestion.createdAt,
          codeChangeAvailable: Boolean(suggestion.codeChange),
        }))
      : [],
  );
  const [detail, setDetail] = useState<SuggestionListItem | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pullRequests, setPullRequests] = useState<SuggestionPullRequest[]>([]);
  const [autoOpen, setAutoOpen] = useState(false);
  const [loading, setLoading] = useState(!isStoryboard);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<SuggestionStatus>("open");
  const [source, setSource] = useState("");
  const [filterCounts, setFilterCounts] = useState<Array<{ status: SuggestionStatus; source: string; count: number }>>([]);
  const [changingStatus, setChangingStatus] = useState(false);
  const [storyboardDismissed, setStoryboardDismissed] = useState<string[]>([]);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [openedIds, setOpenedIds] = useState<string[]>([]);
  const [failedDetailId, setFailedDetailId] = useState<string | null>(null);
  const [pullRequestView, setPullRequestView] = useState({
    suggestionId: "",
    index: 0,
  });
  const selected = suggestionId
    ? isStoryboard
      ? storyboardSuggestions.find((item) => item.id === suggestionId) ?? null
      : detail?.id === suggestionId
        ? detail
        : null
    : null;
  const activeRequests = pullRequests.filter((request) =>
    ["queued", "creating", "created", "merged"].includes(request.status),
  );
  const pendingPullRequests = activeRequests.filter((request) =>
    ["queued", "creating"].includes(request.status),
  );
  const openedPullRequests = activeRequests.filter(
    (request) => request.pullRequestUrl,
  );
  const viewedPullRequestIndex = pullRequestView.suggestionId === suggestionId
    ? pullRequestView.index
    : 0;
  const hasOpenedPullRequest = Boolean(
    selected &&
      (openedIds.includes(selected.id) || openedPullRequests.length > 0),
  );
  useDocumentTitle("Suggestions");

  useEffect(() => {
    if (isStoryboard) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        setLoading(true);
        setError(null);
      }
    });
    const request = suggestionId
      ? fetchSuggestion(suggestionId).then((response) => {
          if (cancelled) return;
          setDetail(response.suggestion);
          setFailedDetailId(null);
          setPullRequests(response.pullRequestState.requests);
        })
      : fetchSuggestions(undefined, { status, source }).then((response) => {
          if (cancelled) return;
          setSuggestions(response.suggestions);
          setNextCursor(response.nextCursor);
          setFilterCounts(response.filters);
          setAutoOpen(response.settings.autoOpenPullRequests);
          setPullRequests([]);
        });
    void request
      .catch((caught: unknown) => {
        if (!cancelled) {
          if (suggestionId) setFailedDetailId(suggestionId);
          setError(
            caught instanceof Error ? caught.message : "Unable to load suggestions",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isStoryboard, suggestionId, status, source]);

  useEffect(() => {
    if (isStoryboard || !suggestionId || pendingPullRequests.length === 0) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void fetchSuggestion(suggestionId)
        .then((response) => {
          if (cancelled) return;
          setDetail(response.suggestion);
          setPullRequests(response.pullRequestState.requests);
        })
        .catch((caught: unknown) => {
          if (!cancelled) {
            setError(
              caught instanceof Error
                ? caught.message
                : "Unable to refresh pull requests",
            );
          }
        });
    }, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [isStoryboard, pendingPullRequests.length, suggestionId]);

  async function openPullRequest() {
    if (!selected) return;
    if (openedPullRequests.length > 0) {
      const request = openedPullRequests[
        viewedPullRequestIndex % openedPullRequests.length
      ]!;
      window.open(request.pullRequestUrl!, "_blank", "noopener,noreferrer");
      setPullRequestView({
        suggestionId: selected.id,
        index: viewedPullRequestIndex + 1,
      });
      return;
    }
    setOpeningId(selected.id);
    setError(null);
    if (isStoryboard) {
      window.setTimeout(() => {
        setOpenedIds((current) => [...new Set([...current, selected.id])]);
        setOpeningId(null);
      }, 900);
      return;
    }
    try {
      await createSuggestionPullRequest(selected.id);
      const response = await fetchSuggestion(selected.id);
      setDetail(response.suggestion);
      setPullRequests(response.pullRequestState.requests);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to open pull request");
    } finally {
      setOpeningId(null);
    }
  }

  async function loadMoreSuggestions() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const response = await fetchSuggestions(nextCursor, { status, source });
      setSuggestions((current) => [...current, ...response.suggestions]);
      setNextCursor(response.nextCursor);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Unable to load more suggestions",
      );
    } finally {
      setLoadingMore(false);
    }
  }

  async function updateAutoOpen(checked: boolean) {
    setAutoOpen(checked);
    setError(null);
    if (isStoryboard) return;
    try {
      const settings = await saveSuggestionSettings({
        autoOpenPullRequests: checked,
      });
      setAutoOpen(settings.autoOpenPullRequests);
    } catch (caught) {
      setAutoOpen(!checked);
      setError(caught instanceof Error ? caught.message : "Unable to save settings");
    }
  }

  const selectedDismissed = isStoryboard ? storyboardDismissed.includes(suggestionId ?? "") : selected?.status === "dismissed";
  async function toggleDismissed() {
    if (!selected) return;
    setChangingStatus(true);
    setError(null);
    try {
      if (isStoryboard) {
        setStoryboardDismissed((current) => selectedDismissed ? current.filter((id) => id !== selected.id) : [...current, selected.id]);
      } else {
        await setSuggestionDismissed(selected.id, !selectedDismissed);
        const response = await fetchSuggestion(selected.id);
        setDetail(response.suggestion);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to update suggestion");
    } finally { setChangingStatus(false); }
  }
  const visibleSuggestions = isStoryboard
    ? suggestions.filter((item) => (storyboardDismissed.includes(item.id) ? "dismissed" : item.status ?? "open") === status && (!source || (item.source ?? "manual") === source))
    : suggestions;
  const counts = isStoryboard
    ? suggestions.map((item) => ({ status: (storyboardDismissed.includes(item.id) ? "dismissed" : item.status ?? "open") as SuggestionStatus, source: item.source ?? "manual", count: 1 }))
    : filterCounts;

  if (suggestionId) {
    if (
      loading ||
      (!isStoryboard && !selected && failedDetailId !== suggestionId)
    ) {
      return (
        <AppShell active="suggestions" density="compact" redesigned>
          <p className="suggestionDetail__loading">Loading suggestion…</p>
        </AppShell>
      );
    }
    if (!selected) {
      return (
        <AppShell active="suggestions" density="compact" redesigned>
          <section className="emptyState">
            <h1>Suggestion not found</h1>
            <p>{error ?? "This suggestion is unavailable."}</p>
            <Link to={basePath}>Back to Suggestions</Link>
          </section>
        </AppShell>
      );
    }
    return (
      <AppShell active="suggestions" density="compact" redesigned>
        <article className="suggestionDetail suggestionDetail--page">
          <nav className="workspaceBreadcrumb" aria-label="Breadcrumb">
            <Link to={basePath}>Suggestions</Link><CaretRightIcon size={12} aria-hidden="true" /><span>{selected.title}</span>
          </nav>
          <header className="suggestionDetail__header">
            <h1>{selected.title}</h1>
            <Button variant="secondary" loading={changingStatus} onClick={() => void toggleDismissed()}>{selectedDismissed ? "Restore" : "Dismiss"}</Button>
          </header>
          {error ? <p className="formError" role="alert">{error}</p> : null}
          <div className="suggestionOverview">
            <p>{selected.subtitle}</p>
            <div className="suggestionMarkdown"><Markdown>{selected.detail}</Markdown></div>
          </div>
          {selected.codeChange ? (
            <section className="suggestionProposedChange">
              <h2>Proposed change</h2>
              <div className="remediationCard">
                <div className="remediationCard__header">
                  <h3>{selected.codeChange.title}</h3>
            {selected.codeChange ? (
              <div aria-live="polite" className="suggestionDetail__action">
                <Button
                  disabled={pendingPullRequests.length > 0}
                  loading={
                    openingId === selected.id || pendingPullRequests.length > 0
                  }
                  onClick={() => void openPullRequest()}
                  variant="secondary"
                >
                  {hasOpenedPullRequest ? (
                    <CheckIcon size={14} aria-hidden="true" />
                  ) : (
                    <PullRequestIcon size={14} aria-hidden="true" />
                  )}
                  {pendingPullRequests.length > 0
                    ? `Opening ${
                        pendingPullRequests.length === 1
                          ? "pull request"
                          : `${pendingPullRequests.length} pull requests`
                      }`
                    : openedPullRequests.length > 0
                      ? openedPullRequests.length === 1
                        ? "View pull request"
                        : `View pull request ${
                            (viewedPullRequestIndex % openedPullRequests.length) + 1
                          } of ${openedPullRequests.length}`
                    : hasOpenedPullRequest
                      ? "Pull request opened"
                    : openingId === selected.id
                      ? "Opening pull request"
                      : "Open pull request"}
                </Button>
              </div>
            ) : null}
                </div>
                <p className="remediationCard__description">{selected.codeChange.description}</p>
                <Suspense fallback={<div className="remediationDiff__loading">Loading proposed diff…</div>}>
                  <RemediationDiff remediation={selected.codeChange} />
                </Suspense>
              </div>
            </section>
          ) : null}
          {selected.relatedIssues?.length ? (
            <section className="suggestionRelatedIssues">
              <h2>Related {selected.relatedIssues.length === 1 ? "issue" : "issues"}</h2>
              {selected.relatedIssues.map((issue) => (
                <Link className="suggestionRelatedIssue" key={issue.id} to={`/issues/${issue.id}`}>
                  <ListBulletsIcon size={16} aria-hidden="true" /><strong>{issue.title}</strong>
                  <time dateTime={issue.createdAt}>{relativeTime(issue.createdAt)}</time><CaretRightIcon size={14} aria-hidden="true" />
                </Link>
              ))}
            </section>
          ) : null}
        </article>
      </AppShell>
    );
  }

  return (
    <AppShell active="suggestions" density="compact" redesigned>
      <header className="workspaceHeading"><h1><FlagIcon size={16} aria-hidden="true" />Suggestions</h1></header>
      <div className="suggestionsToolbar">
        <div className="suggestionStatusFilters" role="group" aria-label="Suggestion status">
          {(["open", "applied", "dismissed"] as const).map((value) => (
            <button key={value} type="button" aria-pressed={status === value} onClick={() => setStatus(value)}>
              {value[0].toUpperCase() + value.slice(1)} <span>{counts.filter((item) => item.status === value && (!source || item.source === source)).reduce((sum, item) => sum + item.count, 0)}</span>
            </button>
          ))}
        </div>
        <SelectField label="Source" className="suggestionSourceFilter" value={source} onChange={setSource} options={[{ label: "All sources", value: "" }, ...[...new Set(counts.map((item) => item.source))].sort().map((value) => ({ label: sourceLabel(value), value }))]} />
      </div>

      {error ? <p className="formError">{error}</p> : null}
      {loading ? (
        <p className="suggestionsLoading">Loading suggestions…</p>
      ) : visibleSuggestions.length === 0 ? (
        <section className="emptyState emptyState--list">
          <h2>No {status} suggestions</h2>
          <p>
            Suggestions will appear when an investigation finds an observability
            gap.
          </p>
        </section>
      ) : (
        <div className="suggestionsDataTable">
          <DataTable<SuggestionSummary>
            aria-label="Observability suggestions"
            columns={[
              {
                header: "Suggestion",
                key: "suggestion",
                render: (suggestion) => (
                  <Link
                    className="suggestionTableTitle"
                    to={`${basePath}/${suggestion.id}`}
                  >
                    <strong>{suggestion.title}</strong>
                  </Link>
                ),
                width: "67%",
              },
              {
                header: "Source",
                key: "source",
                render: (suggestion) => sourceLabel(suggestion.source ?? "manual"),
                width: "16%",
              },
              {
                header: "Identified",
                key: "created",
                render: (suggestion) => (
                  <time dateTime={suggestion.createdAt}>
                    {relativeTime(suggestion.createdAt)}
                  </time>
                ),
                width: "17%",
              },
            ]}
            getRowKey={(suggestion) => suggestion.id}
            rows={visibleSuggestions}
          />
          {nextCursor ? (
            <div className="suggestionsPagination">
              <Button
                loading={loadingMore}
                onClick={() => void loadMoreSuggestions()}
              >
                Load more
              </Button>
            </div>
          ) : null}
        </div>
      )}
      <Switch checked={autoOpen} className="suggestionsAutoOpen" label="Open pull requests automatically" description="Create a pull request whenever a code change is available." onCheckedChange={(checked) => void updateAutoOpen(checked)} />
    </AppShell>
  );
}
