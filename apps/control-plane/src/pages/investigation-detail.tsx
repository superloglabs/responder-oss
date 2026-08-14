import { Fragment, useEffect, useState } from "react";
import Markdown from "react-markdown";
import { Link, Navigate, useParams } from "react-router-dom";
import {
  fetchInvestigation,
  relativeTime,
  type InvestigationDetail,
  type InvestigationDetailResponse,
  type InvestigationTraceEvent,
  retryInvestigation,
} from "../agents-api";
import { AppShell } from "../components/app-shell";
import { ProviderGlyph } from "../components/icons";
import { InvestigationThinking } from "../components/investigation-thinking";
import { InvestigationDetailSkeleton } from "../components/screen-skeletons";
import { Badge, Button, Panel } from "../design-system";
import { useDocumentTitle } from "../use-document-title";
import {
  investigationStatusPresentation,
  providerLabel,
  sentryTriggerDetails,
  sourceActionLabel,
  toolInputSummary,
  traceEventText,
  triggerContext,
  triggerTimestamp,
} from "./investigation-presentation";

const investigationRefreshIntervalMs = 3_000;

function isInvestigationActive(
  status: InvestigationDetailResponse["investigation"]["status"],
): boolean {
  return status === "pending" || status === "investigating";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function traceLabel(event: InvestigationTraceEvent): string {
  const data = asRecord(event.data);
  switch (event.type) {
    case "session.started":
      return "Session started";
    case "turn.started":
      return "Investigation turn started";
    case "message.received":
      return "Trigger received";
    case "reasoning.completed":
      return "Thinking";
    case "step.started":
      return `Model step ${Number(data?.stepIndex ?? 0) + 1} started`;
    case "step.completed":
      return `Model step ${Number(data?.stepIndex ?? 0) + 1} completed`;
    case "step.failed":
      return `Model step ${Number(data?.stepIndex ?? 0) + 1} failed`;
    case "actions.requested":
      return actionRequestLabel(data);
    case "action.result": {
      const result = asRecord(data?.result);
      const tool =
        result?.toolName ?? result?.name ?? result?.type ?? "Tool action";
      return `${String(tool)} ${String(data?.status ?? "completed")}`;
    }
    case "message.completed":
      return "Agent response completed";
    case "turn.completed":
      return "Investigation turn completed";
    case "turn.failed":
      return "Investigation turn failed";
    case "session.failed":
      return "Session failed";
    case "session.waiting":
      return "Session waiting";
    case "session.completed":
      return "Session completed";
    default:
      return event.type
        .split(".")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" · ");
  }
}

function actionRequestLabel(data: Record<string, unknown> | null): string {
  const actions = Array.isArray(data?.actions) ? data.actions : [];
  if (actions.length === 0) return "Tools requested";
  const first = asRecord(actions[0]);
  const name =
    first?.toolName ??
    first?.subagentName ??
    first?.remoteAgentName ??
    first?.kind ??
    "tool";
  return actions.length === 1
    ? `Run ${String(name)}`
    : `Run ${String(name)} +${actions.length - 1} more`;
}

const toolNameAliases: Record<string, string> = {
  bash: "Run command",
  connection_search: "Find integration tools",
  glob: "Find files",
  grep: "Search files",
  load_skill: "Read skill",
  read_file: "Read file",
  read_repository_file: "Read repository file",
  search_existing_issues: "Search existing issues",
  search_repository: "Search repository",
  list_repository_files: "List repository files",
  submit_investigation_report: "Submit investigation report",
  web_fetch: "Open web page",
  web_search: "Search the web",
  write_file: "Write file",
};

function humanizeToolName(value: unknown): string {
  const raw = typeof value === "string" ? value : "tool";
  if (toolNameAliases[raw]) return toolNameAliases[raw];

  const words = raw
    .replace(/^mcp_+/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[_./:-]+|\s+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  const providerNames: Record<string, string> = {
    datadog: "Datadog",
    github: "GitHub",
    sentry: "Sentry",
    slack: "Slack",
    superlog: "Superlog",
  };
  const verbs = new Set([
    "create",
    "delete",
    "find",
    "get",
    "list",
    "load",
    "query",
    "read",
    "run",
    "search",
    "update",
    "write",
  ]);

  if (words.length >= 2 && providerNames[words[0]] && verbs.has(words[1])) {
    const [provider, verb, ...rest] = words;
    return [
      verb.charAt(0).toUpperCase() + verb.slice(1),
      providerNames[provider],
      ...rest,
    ].join(" ");
  }

  const label = words.join(" ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function toolCallId(value: unknown): string | null {
  const record = asRecord(value);
  return typeof record?.callId === "string" ? record.callId : null;
}

function traceSummary(event: InvestigationTraceEvent): string | null {
  const data = asRecord(event.data);
  const message =
    data?.message ?? data?.error ?? data?.finishReason ?? data?.status ?? null;
  if (typeof message !== "string") return null;
  return message.length > 180 ? `${message.slice(0, 177)}…` : message;
}

type TraceKind = "assistant" | "failure" | "reasoning" | "runtime";

const hiddenTranscriptEventTypes = new Set([
  "instructions.configured",
  "message.received",
  "session.completed",
  "session.waiting",
  "step.completed",
  "step.started",
  "turn.completed",
  "turn.started",
]);

function traceKind(event: InvestigationTraceEvent): TraceKind {
  if (event.type.includes("failed")) return "failure";
  if (event.type === "reasoning.completed") return "reasoning";
  if (event.type === "message.completed") return "assistant";
  return "runtime";
}

function traceContent(event: InvestigationTraceEvent): string | null {
  return traceEventText(event);
}

function traceActor(kind: TraceKind): string {
  switch (kind) {
    case "reasoning":
      return "Responder thinking";
    case "assistant":
      return "Responder";
    case "failure":
      return "Error";
    case "runtime":
      return "Runtime";
  }
}

function formatTime(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function investigationSummary(investigation: InvestigationDetail): string {
  return (
    investigation.replayReport?.summary ??
    investigation.structuredReport?.summary ??
    investigation.finding?.summary ??
    "The investigation completed without identifying an actionable issue."
  );
}

export function InvestigationDetailPage() {
  const { agentId, investigationId } = useParams();
  const [detail, setDetail] = useState<InvestigationDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  useDocumentTitle(detail?.investigation.title ?? "Investigation");

  async function load() {
    if (!agentId || !investigationId) return;
    const loaded = await fetchInvestigation(agentId, investigationId);
    setDetail(loaded);
  }

  async function retry() {
    if (!agentId || !investigationId || retrying) return;
    setRetrying(true);
    setError(null);
    try {
      await retryInvestigation(agentId, investigationId);
      await load();
    } catch (caught: unknown) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Unable to retry investigation",
      );
    } finally {
      setRetrying(false);
    }
  }

  useEffect(() => {
    if (!agentId || !investigationId) return;
    let cancelled = false;
    void fetchInvestigation(agentId, investigationId)
      .then((loaded) => {
        if (!cancelled) setDetail(loaded);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        const message =
          caught instanceof Error
            ? caught.message
            : "Unable to load investigation";
        if (message === "Investigation not found") setNotFound(true);
        else setError(message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, investigationId]);

  const investigationStatus = detail?.investigation.status;
  useEffect(() => {
    if (
      !agentId ||
      !investigationId ||
      !investigationStatus ||
      !isInvestigationActive(investigationStatus)
    ) {
      return;
    }

    let cancelled = false;
    let refreshInFlight = false;
    const refresh = async () => {
      if (refreshInFlight || document.visibilityState === "hidden") return;
      refreshInFlight = true;
      try {
        const loaded = await fetchInvestigation(agentId, investigationId);
        if (!cancelled) {
          setDetail(loaded);
          setError(null);
        }
      } catch (caught: unknown) {
        if (!cancelled) {
          const message =
            caught instanceof Error ? caught.message : "Unable to refresh";
          setError(`Live update failed: ${message}. Retrying…`);
        }
      } finally {
        refreshInFlight = false;
      }
    };

    const interval = window.setInterval(
      () => void refresh(),
      investigationRefreshIntervalMs,
    );
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", refreshWhenVisible);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [agentId, investigationId, investigationStatus]);

  if (notFound || !agentId || !investigationId) {
    return <Navigate replace to={agentId ? `/agents/${agentId}` : "/agents"} />;
  }
  if (loading) {
    return (
      <AppShell active="agents" density="investigation">
        <InvestigationDetailSkeleton />
      </AppShell>
    );
  }
  if (!detail) {
    return (
      <AppShell active="agents" density="investigation">
        <section className="emptyState investigationPageState">
          <h1>Unable to load investigation</h1>
          <p>{error ?? "Try again in a moment."}</p>
          <Link className="button button--secondary" to={`/agents/${agentId}`}>
            Back to agent
          </Link>
        </section>
      </AppShell>
    );
  }

  const { investigation, trace, traceError } = detail;
  const isLive = isInvestigationActive(investigation.status);
  const status = investigationStatusPresentation(investigation);
  const resolvedIssueCount = investigation.isReplay
    ? (investigation.replayReport?.issues.length ?? 0)
    : investigation.issues.length;
  const showHeroStatus = !(
    investigation.status === "resolved" && resolvedIssueCount > 0
  );
  const transcriptEvents = trace.events.filter(
    (event) => !hiddenTranscriptEventTypes.has(event.type),
  );
  const toolResults = new Map<string, InvestigationTraceEvent>();
  for (const event of trace.events) {
    if (event.type !== "action.result") continue;
    const result = asRecord(asRecord(event.data)?.result);
    if (typeof result?.callId === "string") {
      toolResults.set(result.callId, event);
    }
  }

  return (
    <AppShell active="agents" density="investigation">
      <div
        className={`investigationPage ${
          isLive ? "investigationPage--live" : "investigationPage--complete"
        }`}
      >
        <header className="investigationHero">
          <Link className="investigationBackLink" to={`/agents/${agentId}`}>
            <span aria-hidden="true">←</span> Back to agent
          </Link>
          <div className="investigationHero__title">
            <h1>{investigation.title}</h1>
            {showHeroStatus ? (
              <Badge tone={status.tone}>{status.label}</Badge>
            ) : null}
          </div>
          <p>
            {triggerContext(investigation.input)} · Started{" "}
            {relativeTime(investigation.startedAt ?? investigation.createdAt)}
          </p>
          {investigation.isReplay && investigation.replayOfInvestigationId ? (
            <p>
              Isolated replay of{" "}
              <Link
                to={`/agents/${agentId}/investigations/${investigation.replayOfInvestigationId}`}
              >
                the original investigation
              </Link>
              . Current provider data and repository heads are used.
            </p>
          ) : null}
        </header>

        {error ? <p className="formError investigationPage__error">{error}</p> : null}

        <div className="investigationPage__body">
          {investigation.status === "resolved" ? (
            <InvestigationOutcome investigation={investigation} />
          ) : investigation.status === "failed" ? (
            <section aria-labelledby="investigation-outcome-heading">
              <Panel
                className="investigationOutcomeCard investigationOutcomeCard--failed"
                padding="none"
                surface="raised"
              >
                <div className="investigationOutcomeCard__inner investigationOutcomeCard__inner--failure">
                  <OutcomeIcon kind="failure" />
                  <div className="investigationOutcomeCard__content">
                    <h2 id="investigation-outcome-heading">
                      Investigation failed
                    </h2>
                    <p>
                      {investigation.failureReason ??
                        "Responder could not complete this investigation."}
                    </p>
                  </div>
                  {!investigation.isReplay ? (
                    <Button
                      loading={retrying}
                      onClick={() => void retry()}
                      size="small"
                      variant="secondary"
                    >
                      Retry investigation
                    </Button>
                  ) : null}
                </div>
              </Panel>
            </section>
          ) : null}

          <InvestigationTrigger investigation={investigation} raised={isLive} />

          <section
            aria-labelledby="investigation-trace-heading"
            className="investigationSection investigationTrace"
          >
            <header className="investigationSectionHeading">
              <h2 id="investigation-trace-heading">Trace</h2>
              <span>
                {trace.sessionId
                  ? `${trace.events.length} events`
                  : "Waiting for session"}
              </span>
            </header>

            {traceError ? <p className="traceError">{traceError}</p> : null}
            {transcriptEvents.length === 0 ? (
              <p className="inlineEmpty investigationTrace__empty">
                Trace events will appear once the investigation starts.
              </p>
            ) : (
              <ol className="traceTimeline">
                {transcriptEvents.map((event, index) => {
                    if (event.type === "session.started") {
                      return (
                        <li
                          className="traceAnnotation"
                          key={`${event.type}-${index}`}
                        >
                          <span
                            aria-hidden="true"
                            className="traceAnnotation__dot"
                          />
                          <span>Session started</span>
                          <time>{formatTime(event.meta?.at ?? null)}</time>
                        </li>
                      );
                    }
                    if (event.type === "action.result") return null;
                    if (event.type === "actions.requested") {
                      const actions = asRecord(event.data)?.actions;
                      if (!Array.isArray(actions)) return null;
                      return (
                        <Fragment key={`${event.type}-${index}`}>
                          {actions.map((action, actionIndex) => {
                            const request = asRecord(action);
                            const callId = toolCallId(action);
                            const resultEvent = callId
                              ? toolResults.get(callId)
                              : undefined;
                            const resultData = asRecord(resultEvent?.data);
                            const result = asRecord(resultData?.result);
                            const failed =
                              resultData?.status === "failed" ||
                              resultData?.error !== undefined;
                            const name =
                              request?.toolName ??
                              request?.subagentName ??
                              request?.remoteAgentName ??
                              request?.kind;
                            const inputSummary = toolInputSummary(
                              request?.input,
                            );
                            return (
                              <li
                                className={`traceTool${
                                  failed ? " traceTool--failed" : ""
                                }`}
                                key={callId ?? `${index}-${actionIndex}`}
                              >
                                <details>
                                  <summary>
                                    <span
                                      aria-hidden="true"
                                      className="traceTool__icon"
                                    >
                                      ⌘
                                    </span>
                                    <span className="traceTool__label">
                                      <span>{humanizeToolName(name)}</span>
                                      {inputSummary ? (
                                        <code>{inputSummary}</code>
                                      ) : null}
                                    </span>
                                  </summary>
                                  <div className="traceTool__data">
                                    <span>Input</span>
                                    <pre>
                                      {JSON.stringify(
                                        request?.input ?? {},
                                        null,
                                        2,
                                      )}
                                    </pre>
                                    {resultEvent ? (
                                      <>
                                        <span>Output</span>
                                        <pre>
                                          {JSON.stringify(
                                            result?.output ??
                                              resultData?.error ??
                                              result ??
                                              {},
                                            null,
                                            2,
                                          )}
                                        </pre>
                                      </>
                                    ) : null}
                                  </div>
                                </details>
                              </li>
                            );
                          })}
                        </Fragment>
                      );
                    }
                    return (
                      <TraceMessage
                        event={event}
                        key={`${event.type}-${index}`}
                      />
                    );
                })}
              </ol>
            )}

            {isLive ? (
              <InvestigationThinking />
            ) : null}
          </section>
        </div>
      </div>
    </AppShell>
  );
}

function InvestigationOutcome({
  investigation,
}: {
  investigation: InvestigationDetail;
}) {
  if (investigation.isReplay && investigation.replayReport) {
    return (
      <section aria-labelledby="investigation-outcome-heading">
        <Panel
          className="investigationOutcomeCard investigationOutcomeCard--clear"
          padding="none"
          surface="raised"
        >
          <div className="investigationOutcomeCard__inner">
            <OutcomeIcon
              kind={investigation.replayReport.issues.length ? "issue" : "clear"}
            />
            <div className="investigationOutcomeCard__content">
              <h2 id="investigation-outcome-heading">
                Replay · {investigation.replayReport.headline}
              </h2>
              <p>{investigation.replayReport.summary}</p>
              {investigation.replayReport.issues.length ? (
                <ul>
                  {investigation.replayReport.issues.map((issue, index) => (
                    <li key={`${issue.issueId ?? issue.title ?? "issue"}-${index}`}>
                      {issue.severity ? `${issue.severity} · ` : ""}
                      {issue.title ?? issue.issueId ?? "Existing issue"}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </div>
        </Panel>
      </section>
    );
  }

  if (investigation.issues.length === 0) {
    return (
      <section aria-labelledby="investigation-outcome-heading">
        <Panel
          className="investigationOutcomeCard investigationOutcomeCard--clear"
          padding="none"
          surface="raised"
        >
          <div className="investigationOutcomeCard__inner">
            <OutcomeIcon kind="clear" />
            <div className="investigationOutcomeCard__content">
              <h2 id="investigation-outcome-heading">No issues found</h2>
              <p>{investigationSummary(investigation)}</p>
            </div>
          </div>
        </Panel>
      </section>
    );
  }

  return (
    <section aria-labelledby="investigation-outcome-heading">
      <Panel
        className="investigationOutcomeCard investigationOutcomeCard--issues"
        padding="none"
        surface="raised"
      >
        <div className="investigationOutcomeCard__inner investigationOutcomeCard__inner--issues">
          <header className="investigationOutcomeCard__header">
            <div>
              <OutcomeIcon kind="issue" />
              <h2 id="investigation-outcome-heading">
                {investigation.issues.length}{" "}
                {investigation.issues.length === 1 ? "issue" : "issues"} found
              </h2>
            </div>
            {investigation.issues.length === 1 ? (
              <Link to={`/issues/${investigation.issues[0].id}`}>
                View issue <span aria-hidden="true">→</span>
              </Link>
            ) : null}
          </header>
          <div className="investigationOutcomeCard__issues">
            {investigation.issues.map((issue) => (
              <article key={issue.id}>
                <Badge tone="warning">{issue.severity}</Badge>
                <div>
                  <Link to={`/issues/${issue.id}`}>
                    <h3>{issue.title}</h3>
                  </Link>
                  <p>{issue.description}</p>
                </div>
              </article>
            ))}
          </div>
        </div>
      </Panel>
    </section>
  );
}

function InvestigationTrigger({
  investigation,
  raised,
}: {
  investigation: InvestigationDetail;
  raised: boolean;
}) {
  const { input } = investigation;
  const occurredAt = triggerTimestamp(input);
  const sentryDetails = sentryTriggerDetails(input);
  return (
    <section
      aria-labelledby="investigation-trigger-heading"
      className="investigationSection"
    >
      <header className="investigationSectionHeading">
        <h2 id="investigation-trigger-heading">Trigger</h2>
      </header>
      <Panel
        className="investigationTriggerCard"
        padding="none"
        surface={raised ? "raised" : "base"}
      >
        <div className="investigationTriggerCard__inner">
          <ProviderIcon provider={input.provider} />
          <div className="investigationTriggerCard__content">
            <div className="investigationTriggerCard__byline">
              <strong>{providerLabel(input.provider)}</strong>
              {occurredAt ? (
                <time dateTime={occurredAt}>{formatTime(occurredAt)}</time>
              ) : null}
              {input.sourceUrl ? (
                <a
                  className="investigationTriggerCard__source"
                  href={input.sourceUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  {sourceActionLabel(input.provider)}{" "}
                  <span aria-hidden="true">↗</span>
                </a>
              ) : null}
            </div>
            {sentryDetails?.shortId ? (
              <span className="investigationTriggerCard__issueId">
                {sentryDetails.shortId}
              </span>
            ) : null}
            <h3>{input.title}</h3>
            {sentryDetails ? (
              <SentryTriggerBody details={sentryDetails} />
            ) : (
              <p className="investigationTriggerCard__body">{input.body}</p>
            )}
          </div>
        </div>
      </Panel>
    </section>
  );
}

function SentryTriggerBody({
  details,
}: {
  details: NonNullable<ReturnType<typeof sentryTriggerDetails>>;
}) {
  const project = details.projectName ?? details.projectSlug;
  const classification =
    details.issueType && details.issueCategory !== details.issueType
      ? [details.issueType, details.issueCategory].filter(Boolean).join(" · ")
      : details.issueType ?? details.issueCategory;
  const badges = Array.from(
    new Set(
      [
        details.status,
        details.substatus,
        details.isUnhandled === true ? "Unhandled" : null,
      ].filter((value): value is string => Boolean(value)),
    ),
  );
  const facts = [
    { label: "Project", value: project },
    { label: "Platform", value: details.platform },
    { label: "Type", value: classification },
    { label: "Priority", value: details.priority },
    { label: "Events", value: details.count },
    {
      label: "Users",
      value:
        details.userCount === null ? null : String(details.userCount),
    },
  ].filter(
    (fact): fact is { label: string; value: string } => fact.value !== null,
  );
  const errorValue =
    details.errorValue && details.errorValue !== details.errorType
      ? details.errorValue
      : null;

  return (
    <div className="investigationSentryTrigger">
      {details.culprit ? (
        <code className="investigationSentryTrigger__culprit">
          {details.culprit}
        </code>
      ) : null}
      {badges.length > 0 ? (
        <ul
          aria-label="Sentry issue labels"
          className="investigationSentryTrigger__badges"
        >
          {badges.map((badge) => (
            <li key={badge}>{badge}</li>
          ))}
        </ul>
      ) : null}
      {facts.length > 0 ? (
        <dl className="investigationSentryTrigger__facts">
          {facts.map((fact) => (
            <div key={fact.label}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {details.errorType || errorValue ? (
        <div className="investigationSentryTrigger__error">
          {details.errorType ? <strong>{details.errorType}</strong> : null}
          {errorValue ? <p>{errorValue}</p> : null}
          {details.functionName || details.filename ? (
            <code>
              {[details.functionName, details.filename]
                .filter(Boolean)
                .join(" · ")}
            </code>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function TraceMessage({ event }: { event: InvestigationTraceEvent }) {
  const summary = traceSummary(event);
  const kind = traceKind(event);
  const content = traceContent(event);

  if (kind === "reasoning") {
    return (
      <li className="traceMessageItem">
        <Panel
          className="traceMessage traceMessage--reasoning"
          padding="none"
          surface="raised"
        >
          <details className="traceReasoning" open>
            <summary>
              <span aria-hidden="true" className="traceReasoning__icon">
                <svg fill="none" viewBox="0 0 16 16">
                  <path d="M8 1.75c.45 3.73 2.52 5.8 6.25 6.25C10.52 8.45 8.45 10.52 8 14.25 7.55 10.52 5.48 8.45 1.75 8 5.48 7.55 7.55 5.48 8 1.75Z" stroke="currentColor" strokeLinejoin="round" />
                </svg>
              </span>
              <strong>Responder thinking</strong>
              <time>{formatTime(event.meta?.at ?? null)}</time>
              <span aria-hidden="true" className="traceReasoning__chevron">⌄</span>
            </summary>
            {content ? (
              <div className="traceReasoning__content">{content}</div>
            ) : null}
          </details>
        </Panel>
      </li>
    );
  }

  const body = (
    <>
      {kind !== "assistant" ? (
        <span aria-hidden="true" className="traceMessage__avatar">
          {traceActor(kind).charAt(0)}
        </span>
      ) : null}
      <article>
        {kind !== "assistant" ? (
          <header>
            <span>
              <strong>{traceActor(kind)}</strong>
              <small>{traceLabel(event)}</small>
            </span>
            <time>{formatTime(event.meta?.at ?? null)}</time>
          </header>
        ) : null}
        {content ? (
          <div className="traceMessage__content traceMessage__markdown">
            <Markdown>{content}</Markdown>
          </div>
        ) : summary ? (
          <p className="traceMessage__summary">{summary}</p>
        ) : null}
        {kind !== "assistant" ? (
          <details className="traceMessage__raw">
            <summary>Event data</summary>
            <pre>{JSON.stringify(event.data ?? {}, null, 2)}</pre>
          </details>
        ) : null}
      </article>
    </>
  );

  return <li className={`traceMessage traceMessage--${kind}`}>{body}</li>;
}

function ProviderIcon({
  provider,
}: {
  provider: InvestigationDetail["input"]["provider"];
}) {
  return (
    <ProviderGlyph className="investigationProviderIcon" provider={provider} />
  );
}

function OutcomeIcon({ kind }: { kind: "clear" | "failure" | "issue" }) {
  return (
    <span
      aria-hidden="true"
      className={`investigationOutcomeIcon investigationOutcomeIcon--${kind}`}
    >
      {kind === "clear" ? (
        <svg fill="none" viewBox="0 0 24 24">
          <path d="m6.75 12.25 3.2 3.2 7.3-7.3" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
        </svg>
      ) : kind === "issue" ? (
        <svg fill="none" viewBox="0 0 24 24">
          <path d="M12 7.2v5.4M12 16.8h.01" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
          <circle cx="12" cy="12" r="8.25" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      ) : (
        <svg fill="none" viewBox="0 0 24 24">
          <path d="m8.5 8.5 7 7m0-7-7 7" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
          <circle cx="12" cy="12" r="8.25" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      )}
    </span>
  );
}
