import {
  ArrowUpIcon,
  ArrowUpRightIcon,
  CaretDownIcon,
  CaretRightIcon,
  CheckIcon,
  CopyIcon,
  GitPullRequestIcon,
  StopIcon,
  XIcon,
} from "@phosphor-icons/react";
import { type FormEvent, type KeyboardEvent, type RefObject, useCallback, useEffect, useRef, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import type { AutomationTranscriptTool } from "../../../../packages/core/src/automations/transcript";
import { relativeTime } from "../agents-api";
import {
  activityLabel,
  automationRunActivity,
  automationRunTimeline,
  formatDuration,
  lastAgentMessage,
  toolActionLabels,
  type AutomationRunEntry,
} from "../automation-run-timeline";
import {
  cancelAutomationRun,
  fetchAutomation,
  fetchAutomationRun,
  runAutomation,
  sendAutomationRunMessage,
  type AutomationDetail,
  type AutomationRunDetail,
  type AutomationRunStatus,
} from "../automations-api";
import { AppShell } from "../components/app-shell";
import { ProviderGlyph } from "../components/icons";
import { AutomationTriggerIcon } from "../components/automation-trigger-icon";
import { providerDisplayName, providerGlyphs, type ProviderGlyphId } from "../components/provider-glyphs";
import { copyToClipboard } from "../copy-to-clipboard";
import { useDocumentTitle } from "../use-document-title";
import "./automation-create.css";
import "./automation-run.css";

const statusLabels: Record<AutomationRunStatus, string> = {
  cancelled: "Cancelled",
  failed: "Failed",
  pending: "Queued",
  running: "Running",
  succeeded: "Completed",
};

function isActive(status: AutomationRunStatus) {
  return status === "pending" || status === "running";
}

function clockTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", hourCycle: "h23", minute: "2-digit" }).format(new Date(value));
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

function RunHeader({ automationId, automationName, current, status, title }: {
  automationId: string;
  automationName: string;
  current: string;
  status?: AutomationRunStatus;
  title: string;
}) {
  return <header className="automationCreate__header">
    <nav aria-label="Breadcrumb" className="automationCreate__breadcrumb">
      <Link to="/automations">Automations</Link><span aria-hidden="true">›</span>
      <Link to={`/automations/${automationId}`}>{automationName}</Link><span aria-hidden="true">›</span>
      <span aria-current="page">{current}</span>
    </nav>
    <div className="automationCreate__titleRow">
      <h1>{title}</h1>
      <span className="automationCreate__spacer" />
      {status ? <span className={`automationRun__status automationRun__status--${status}`}><i aria-hidden="true" />{statusLabels[status]}</span> : null}
    </div>
  </header>;
}

function triggerMeta(run: AutomationRunDetail): string[] {
  const { attributes, provider } = run.trigger;
  if (provider === "manual") return ["Manual run"];
  if (provider === "sentry") {
    return ["Sentry", attributes.action === "created" ? "New issue" : "Regression", typeof attributes.shortId === "string" ? attributes.shortId : null].filter((value): value is string => Boolean(value));
  }
  if (provider === "discord") return ["Discord", typeof attributes.username === "string" ? `@${attributes.username}` : "Command"];
  if (provider === "slack") return ["Slack", "Message"];
  if (provider === "schedule") {
    const frequency = attributes.frequency === "hourly" ? "Hourly" : attributes.frequency === "daily" ? "Daily" : "Weekly";
    return ["Schedule", frequency];
  }
  return [providerDisplayName(provider)];
}

function TriggerCard({ run }: { run: AutomationRunDetail }) {
  const { provider, sourceUrl, title } = run.trigger;
  const project = run.trigger.attributes.projectName ?? run.trigger.attributes.projectSlug;
  return <article className="automationRun__card automationRun__trigger" aria-label="Trigger">
    <div className="automationRun__triggerMeta">
      {provider === "schedule" ? <AutomationTriggerIcon kind="schedule" /> : provider in providerGlyphs ? <ProviderGlyph decorative provider={provider as ProviderGlyphId} /> : null}
      <span>{triggerMeta(run).join(" · ")}</span>
      <span className="automationCreate__spacer" />
      <time dateTime={run.createdAt} title={new Date(run.createdAt).toLocaleString()}>{clockTime(run.createdAt)}</time>
      {sourceUrl ? <a aria-label={`Open in ${providerDisplayName(provider)}`} href={sourceUrl} rel="noreferrer" target="_blank"><ArrowUpRightIcon size={12} /></a> : null}
    </div>
    <strong>{title}</strong>
    {typeof project === "string" ? <small>{project}</small> : null}
  </article>;
}

function ToolRow({ tool }: { tool: AutomationTranscriptTool }) {
  return <li className="automationRun__tool">
    {tool.status === "failed" ? <XIcon aria-label="Failed" className="automationRun__toolFailed" size={14} /> : <CheckIcon aria-label="Succeeded" size={14} />}
    <span className="automationRun__toolAction">{tool.action === "query" && tool.provider ? providerDisplayName(tool.provider) : toolActionLabels[tool.action]}</span>
    <code title={tool.target}>{tool.target}</code>
    <span className="automationRun__toolResult">{tool.status === "failed" ? "Failed" : null}</span>
    <span className="automationRun__toolDuration">{tool.durationMs === undefined ? null : formatDuration(tool.durationMs)}</span>
  </li>;
}

// Reasoning and tool calls between two messages. While the agent is still
// working on it, it stays open under a shimmering "Thinking" label; once the
// next message arrives it folds into "Thought for 12s".
function ActivityGroup({ entry, live }: { entry: Extract<AutomationRunEntry, { kind: "activity" }>; live: boolean }) {
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? live;
  const label = activityLabel(entry);
  return <div className="automationRun__tools">
    <button aria-expanded={open} className="automationRun__toolsToggle" onClick={() => setChosen(!open)} type="button">
      {open ? <CaretDownIcon size={14} /> : <CaretRightIcon size={14} />}
      <span className={live ? "automationRun__shimmer" : undefined}>{live ? "Thinking" : label.title}</span>
      {label.detail ? <small>{label.detail}</small> : null}
    </button>
    {open ? <ul className="automationRun__toolList">
      {entry.steps.map((step, index) => step.kind === "tool"
        ? <ToolRow key={index} tool={step} />
        : <li className="automationRun__reasoning" key={index}><Markdown components={markdownComponents}>{step.text}</Markdown></li>)}
    </ul> : null}
  </div>;
}

// Agents link to files in their sandbox; only web links can be followed.
const markdownComponents: Components = {
  a: ({ children, href }) => href && /^https?:\/\//u.test(href)
    ? <a href={href} rel="noreferrer" target="_blank">{children}</a>
    : <span className="automationRun__fileLink">{children}</span>,
};

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

// Types out a message that arrived while the page was open, with a caret.
function AgentMessage({ animate, text }: { animate: boolean; text: string }) {
  const [shown, setShown] = useState(() => animate && !prefersReducedMotion() ? 0 : text.length);
  const typing = shown < text.length;
  useEffect(() => {
    if (!typing) return;
    // Long messages speed up so none takes more than a few seconds.
    const charactersPerSecond = Math.max(90, text.length / 2.5);
    let frame = 0;
    let previous: number | undefined;
    const step = (time: number) => {
      const elapsed = previous === undefined ? 0 : time - previous;
      previous = time;
      setShown((current) => Math.min(text.length, current + Math.max(1, Math.round((elapsed / 1_000) * charactersPerSecond))));
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [typing, text.length]);
  return <div className={`automationRun__message${typing ? " automationRun__message--typing" : ""}`}>
    <Markdown components={markdownComponents}>{typing ? text.slice(0, shown) : text}</Markdown>
  </div>;
}

function scrollParent(node: HTMLElement): HTMLElement {
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    const { overflowY } = getComputedStyle(parent);
    if ((overflowY === "auto" || overflowY === "scroll") && parent.scrollHeight > parent.clientHeight) return parent;
  }
  return document.scrollingElement as HTMLElement ?? document.documentElement;
}

// Keeps the newest content in view while the reader is at the bottom.
function useFollowBottom(content: RefObject<HTMLElement | null>, enabled: boolean) {
  useEffect(() => {
    const node = content.current;
    if (!node || !enabled) return;
    const container = scrollParent(node);
    const nearBottom = () => container.scrollHeight - container.scrollTop - container.clientHeight < 120;
    let following = nearBottom();
    const onScroll = () => { following = nearBottom(); };
    const observer = new ResizeObserver(() => {
      if (following) container.scrollTop = container.scrollHeight;
    });
    container.addEventListener("scroll", onScroll, { passive: true });
    observer.observe(node);
    return () => {
      container.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, [content, enabled]);
}

function PullRequestCard({ entry }: { entry: Extract<AutomationRunEntry, { kind: "pullRequest" }> }) {
  return <article className="automationRun__card automationRun__pullRequest">
    <GitPullRequestIcon aria-hidden="true" size={18} />
    <div>
      <strong>{entry.title ?? "Pull request opened"}</strong>
      <small>{[entry.repository?.replace("/", " / "), entry.number ? `PR #${entry.number}` : null].filter(Boolean).join(" · ")}</small>
    </div>
    <a className="automationRun__button" href={entry.url} rel="noreferrer" target="_blank">View pull request<ArrowUpRightIcon size={12} /></a>
  </article>;
}

function Entry({ animate, entry, live, run }: { animate: boolean; entry: AutomationRunEntry; live: boolean; run: AutomationRunDetail }) {
  switch (entry.kind) {
    case "trigger":
      return <TriggerCard run={run} />;
    case "user":
      return <article className="automationRun__card automationRun__user" aria-label={`Message from ${entry.authorName}`}>
        <header><span>{entry.authorName}</span><time dateTime={entry.createdAt} title={new Date(entry.createdAt).toLocaleString()}>{clockTime(entry.createdAt)}</time></header>
        <p>{entry.text}</p>
      </article>;
    case "message":
      return <AgentMessage animate={animate} text={entry.text} />;
    case "activity":
      return <ActivityGroup entry={entry} live={live} />;
    case "pullRequest":
      return <PullRequestCard entry={entry} />;
    case "notice":
      return <p className="automationRun__notice">{entry.text}</p>;
    case "failure":
      return <p className="automationRun__failure" role="alert">{entry.text}</p>;
  }
}

function Composer({ autoFocus = false, disabledReason, onSend, onStop, placeholder, stopping = false }: {
  autoFocus?: boolean;
  disabledReason: string | null;
  onSend: (message: string) => Promise<boolean>;
  onStop?: () => void;
  placeholder: string;
  stopping?: boolean;
}) {
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const disabled = disabledReason !== null || sending;

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const text = message.trim();
    if (!text || disabled) return;
    setSending(true);
    const sent = await onSend(text);
    setSending(false);
    if (sent) setMessage("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }

  return <form className="automationRun__card automationRun__composer" onSubmit={(event) => void submit(event)}>
    <textarea aria-label="Message" autoFocus={autoFocus} disabled={disabledReason !== null} maxLength={20_000} onChange={(event) => setMessage(event.target.value)} onKeyDown={onKeyDown} placeholder={disabledReason ?? placeholder} rows={1} value={message} />
    <div className="automationRun__composerActions">
      {onStop
        ? <button className="automationCreate__secondary" disabled={stopping} onClick={onStop} type="button"><StopIcon size={14} />{stopping ? "Stopping…" : "Stop"}</button>
        : <button className="automationCreate__save" disabled={disabled || !message.trim()} type="submit">{sending ? "Sending…" : "Send"}<ArrowUpIcon size={14} /></button>}
    </div>
  </form>;
}

export function AutomationRunPage() {
  const { automationId, runId } = useParams();
  if (!automationId || !runId) return <Navigate replace to="/automations" />;
  return <AutomationRunContent automationId={automationId} key={runId} runId={runId} />;
}

function AutomationRunContent({ automationId, runId }: { automationId: string; runId: string }) {
  const [run, setRun] = useState<AutomationRunDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const request = useRef(0);
  // Messages on screen when the page opened appear at once; later ones type out.
  const [initialMessages, setInitialMessages] = useState<Set<string> | null>(null);
  const transcript = useRef<HTMLElement>(null);
  useFollowBottom(transcript, run !== null);
  useDocumentTitle(run ? `Run #${run.number} · ${run.automationName}` : "Automation run");

  const load = useCallback(async () => {
    const generation = ++request.current;
    try {
      const loaded = await fetchAutomationRun(runId);
      if (request.current !== generation) return;
      setInitialMessages((current) => current ?? new Set(
        automationRunTimeline(loaded).flatMap((entry) => entry.kind === "message" ? [entry.key] : []),
      ));
      setRun(loaded);
      setError(null);
    } catch (cause) {
      if (request.current !== generation) return;
      const message = errorMessage(cause, "Unable to load run");
      if (message === "Automation run not found") setMissing(true);
      else setError(message);
    }
  }, [runId]);

  useEffect(() => {
    void Promise.resolve().then(load);
    return () => { request.current += 1; };
  }, [load]);

  // An active run gains events and changes status, so keep it current.
  const active = run ? isActive(run.status) : false;
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => void load(), 2_000);
    return () => window.clearInterval(timer);
  }, [active, load]);

  if (missing || (run && run.automationId !== automationId)) {
    return <Navigate replace to={run ? `/automations/${run.automationId}/runs/${run.id}` : `/automations/${automationId}`} />;
  }
  if (!run) {
    return <AppShell active="automations" redesigned density="create">
      {error
        ? <div className="automationRun__loading" role="alert"><p>{error}</p><button className="automationCreate__secondary" onClick={() => { setError(null); void load(); }} type="button">Retry</button></div>
        : <p className="automationRun__loading" role="status">Loading run…</p>}
    </AppShell>;
  }

  const entries = automationRunTimeline(run);
  const finalMessage = lastAgentMessage(entries);
  const lastEntry = entries.at(-1);
  const liveActivity = active && lastEntry?.kind === "activity" ? lastEntry.key : null;

  async function send(message: string) {
    setActionError(null);
    try {
      await sendAutomationRunMessage(runId, message);
      await load();
      return true;
    } catch (cause) {
      setActionError(errorMessage(cause, "Unable to send the follow-up"));
      return false;
    }
  }

  async function stop() {
    setActionError(null);
    try {
      await cancelAutomationRun(runId);
      await load();
    } catch (cause) {
      setActionError(errorMessage(cause, "Unable to stop the run"));
    }
  }

  async function copyFinalMessage() {
    if (!finalMessage) return;
    try {
      await copyToClipboard(finalMessage);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setActionError("Unable to copy the message");
    }
  }

  return <AppShell active="automations" redesigned density="create">
    <div className="automationCreate automationRun">
      <RunHeader automationId={run.automationId} automationName={run.automationName} current={`Run #${run.number}`} status={run.status} title={run.trigger.title} />
      <section aria-label="Run transcript" className="automationRun__transcript" ref={transcript}>
        {entries.map((entry) => <Entry animate={!initialMessages?.has(entry.key)} entry={entry} key={entry.key} live={entry.key === liveActivity} run={run} />)}
        {active
          ? liveActivity
            ? <span className="automationRun__srOnly" role="status">Thinking</span>
            : <p className="automationRun__activity" role="status"><span className="automationRun__shimmer">{automationRunActivity(run)}</span></p>
          : run.completedAt && finalMessage
            ? <div className="automationRun__footer">
                <button aria-label={copied ? "Copied" : "Copy the agent's last message"} onClick={() => void copyFinalMessage()} title={copied ? "Copied" : "Copy"} type="button">{copied ? <CheckIcon size={16} /> : <CopyIcon size={16} />}</button>
                <time dateTime={run.completedAt} title={new Date(run.completedAt).toLocaleString()}>{relativeTime(run.completedAt)}</time>
              </div>
            : null}
      </section>
      {actionError ? <p className="formError" role="alert">{actionError}</p> : null}
      <Composer
        disabledReason={active ? "The agent is working. Send a follow-up when it finishes." : run.automationEnabled ? null : "Turn the automation on to continue this run."}
        onSend={send}
        onStop={active ? () => void stop() : undefined}
        placeholder="Send a follow-up to continue this run…"
        stopping={Boolean(run.cancelRequestedAt)}
      />
    </div>
  </AppShell>;
}

// An empty chat that starts a manual run with the member's first message.
export function AutomationTestChatPage() {
  const { automationId } = useParams();
  const navigate = useNavigate();
  const [automation, setAutomation] = useState<AutomationDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useDocumentTitle(automation ? `Test chat · ${automation.name}` : "Test chat");

  useEffect(() => {
    let cancelled = false;
    if (!automationId) return;
    void fetchAutomation(automationId).then((loaded) => {
      if (!cancelled) setAutomation(loaded);
    }).catch((cause: unknown) => {
      if (cancelled) return;
      const message = errorMessage(cause, "Unable to load automation");
      if (message === "Automation not found") setMissing(true);
      else setError(message);
    });
    return () => { cancelled = true; };
  }, [automationId]);

  if (!automationId || missing) return <Navigate replace to="/automations" />;
  if (!automation) {
    return <AppShell active="automations" redesigned density="create">
      <p className="automationRun__loading" role={error ? "alert" : "status"}>{error ?? "Loading automation…"}</p>
    </AppShell>;
  }

  async function start(message: string) {
    setError(null);
    try {
      const { runId } = await runAutomation(automation!.id, message);
      navigate(`/automations/${automation!.id}/runs/${runId}`, { replace: true });
      return true;
    } catch (cause) {
      setError(errorMessage(cause, "Unable to start the test"));
      return false;
    }
  }

  return <AppShell active="automations" redesigned density="create">
    <div className="automationCreate automationRun">
      <RunHeader automationId={automation.id} automationName={automation.name} current="Test chat" title="Test chat" />
      <section aria-label="Run transcript" className="automationRun__transcript automationRun__transcript--empty">
        <p>Send a message to start a test run. The agent treats it as the trigger event and works with this automation's instructions, repositories and connectors.</p>
      </section>
      {error ? <p className="formError" role="alert">{error}</p> : null}
      <Composer
        autoFocus
        disabledReason={automation.enabled ? null : "Turn the automation on to test it."}
        onSend={start}
        placeholder="Describe a test event or give the agent a task…"
      />
    </div>
  </AppShell>;
}
