import { lazy, Suspense, useEffect, useState } from "react";
import Markdown from "react-markdown";
import { Link, useLocation, useParams } from "react-router-dom";
import {
  createSuggestionPullRequest,
  fetchSuggestion,
  fetchSuggestions,
  relativeTime,
  saveSuggestionSettings,
  type SuggestionListItem,
  type SuggestionPullRequest,
  type SuggestionSummary,
} from "../agents-api";
import { AppShell } from "../components/app-shell";
import {
  ArrowIcon,
  PullRequestIcon,
} from "../components/icons";
import { Button, DataTable, Switch, Tabs } from "../design-system";
import { dateGroupLabel } from "../date-presentation";
import { useDocumentTitle } from "../use-document-title";

const RemediationDiff = lazy(() =>
  import("../components/remediation-diff").then((module) => ({
    default: module.RemediationDiff,
  })),
);

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1_000).toISOString();
}

type SuggestionDetailTab = "code" | "description";

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
  const [detailView, setDetailView] = useState<{
    suggestionId: string;
    tab: SuggestionDetailTab;
  }>({ suggestionId: "", tab: "description" });
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
  const activeDetailTab =
    selected?.codeChange && detailView.suggestionId === selected.id
      ? detailView.tab
      : "description";
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
      : fetchSuggestions().then((response) => {
          if (cancelled) return;
          setSuggestions(response.suggestions);
          setNextCursor(response.nextCursor);
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
  }, [isStoryboard, suggestionId]);

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
      const response = await fetchSuggestions(nextCursor);
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

  if (suggestionId) {
    if (
      loading ||
      (!isStoryboard && !selected && failedDetailId !== suggestionId)
    ) {
      return (
        <AppShell active="suggestions" density="compact">
          <p className="suggestionDetail__loading">Loading suggestion…</p>
        </AppShell>
      );
    }
    if (!selected) {
      return (
        <AppShell active="suggestions" density="compact">
          <section className="emptyState">
            <h1>Suggestion not found</h1>
            <p>{error ?? "This suggestion is unavailable."}</p>
            <Link to={basePath}>Back to Suggestions</Link>
          </section>
        </AppShell>
      );
    }
    return (
      <AppShell active="suggestions" density="compact">
        <article className="suggestionDetail suggestionDetail--page">
          <Link className="suggestionDetail__back" to={basePath}>
            ← Suggestions
          </Link>
          <header
            className={`suggestionDetail__header${
              selected.codeChange
                ? ""
                : " suggestionDetail__header--withoutAction"
            }`}
          >
            <div className="suggestionDetail__headingCopy">
              <h1>{selected.title}</h1>
              <p>{selected.subtitle}</p>
            </div>
            {selected.codeChange ? (
              <div aria-live="polite" className="suggestionDetail__action">
                <Button
                  disabled={pendingPullRequests.length > 0}
                  loading={
                    openingId === selected.id || pendingPullRequests.length > 0
                  }
                  onClick={() => void openPullRequest()}
                  variant="primary"
                >
                  {hasOpenedPullRequest ? (
                    <span aria-hidden="true">✓</span>
                  ) : (
                    <PullRequestIcon />
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
          </header>

          <div className="suggestionDetail__body">
            {error ? <p className="formError">{error}</p> : null}
            {selected.codeChange ? (
              <div className="suggestionDetail__tabs">
                <Tabs<SuggestionDetailTab>
                  aria-label="Suggestion detail"
                  onChange={(tab) =>
                    setDetailView({ suggestionId: selected.id, tab })
                  }
                  options={[
                    { label: "Description", value: "description" },
                    { label: "Code", value: "code" },
                  ]}
                  value={activeDetailTab}
                />
              </div>
            ) : null}
            <div
              aria-label={activeDetailTab === "code" ? "Code" : "Description"}
              className="suggestionDetail__panel"
              role={selected.codeChange ? "tabpanel" : undefined}
            >
              {activeDetailTab === "code" && selected.codeChange ? (
                <Suspense
                  fallback={
                    <div className="remediationDiff__loading">
                      Loading proposed diff…
                    </div>
                  }
                >
                  <RemediationDiff remediation={selected.codeChange} />
                </Suspense>
              ) : (
                <div className="suggestionMarkdown">
                  <Markdown>{selected.detail}</Markdown>
                </div>
              )}
            </div>
          </div>
        </article>
      </AppShell>
    );
  }

  return (
    <AppShell active="suggestions" density="compact">
      <section className="suggestionsHeading">
        <div>
          <h1>Suggestions</h1>
          <p>
            Our agent will find gaps in observability and propose improvements
            in your logging setup.
          </p>
        </div>
        <Switch
          checked={autoOpen}
          className="suggestionsAutoOpen"
          description="Create a pull request whenever a code change is available."
          label="Open pull requests automatically"
          onCheckedChange={(checked) => void updateAutoOpen(checked)}
        />
      </section>

      {error ? <p className="formError">{error}</p> : null}
      {loading ? (
        <p className="suggestionsLoading">Loading suggestions…</p>
      ) : suggestions.length === 0 ? (
        <section className="emptyState emptyState--list">
          <h2>No suggestions yet</h2>
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
                    <span>{suggestion.subtitle}</span>
                  </Link>
                ),
                width: "67%",
              },
              {
                header: "Code change",
                key: "codeChange",
                render: (suggestion) => (
                  <span className="suggestionCodeAvailability">
                    {suggestion.codeChangeAvailable ? (
                      <>
                        <PullRequestIcon /> Available
                      </>
                    ) : (
                      "—"
                    )}
                  </span>
                ),
                width: "16%",
              },
              {
                header: "Created",
                key: "created",
                render: (suggestion) => (
                  <time dateTime={suggestion.createdAt}>
                    {relativeTime(suggestion.createdAt)}
                  </time>
                ),
                width: "12%",
              },
              {
                align: "right",
                header: "",
                key: "open",
                render: (suggestion) => (
                  <Link
                    aria-label={`Open ${suggestion.title}`}
                    className="suggestionsTable__arrow"
                    to={`${basePath}/${suggestion.id}`}
                  >
                    <ArrowIcon />
                  </Link>
                ),
                width: "5%",
              },
            ]}
            getRowGroup={(suggestion) => dateGroupLabel(suggestion.createdAt)}
            getRowKey={(suggestion) => suggestion.id}
            rows={suggestions}
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
    </AppShell>
  );
}
