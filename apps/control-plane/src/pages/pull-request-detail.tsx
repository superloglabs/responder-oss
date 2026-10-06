import { ArrowUpRightIcon, GitCommitIcon } from "@phosphor-icons/react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import { Link, Navigate, useMatch, useNavigate, useParams } from "react-router-dom";
import { relativeTime } from "../agents-api";
import { AppShell } from "../components/app-shell";
import { PullRequestDetailSkeleton } from "../components/screen-skeletons";
import { SegmentedControl } from "../design-system";
import { filesChangedLabel } from "../pull-request-diff";
import {
  commitMessageParts,
  conversationAction,
  lineCountLabel,
  pullRequestReference,
  pullRequestTitle,
  shortSha,
} from "../pull-request-presentation";
import {
  fetchPullRequest,
  fetchPullRequestFiles,
  type AutomationPullRequestDetail,
  type AutomationPullRequestFiles,
  type PullRequestCommit,
  type PullRequestConversationEntry,
  type PullRequestPerson,
} from "../pull-requests-api";
import { useDocumentTitle } from "../use-document-title";
import { PullRequestStatus } from "./pull-requests";
import "./automation-create.css";
import "./automation-run.css";
import "./pull-requests.css";

// The diff viewer and its syntax highlighter load with the files tab.
const PullRequestFiles = lazy(() =>
  import("../components/pull-request-files").then((module) => ({ default: module.PullRequestFiles })),
);

// Links open on GitHub. Images there need a GitHub session, so they become
// links too. Raw HTML, such as the comments review bots leave, is dropped and
// the text inside it is kept.
const markdownComponents: Components = {
  a: ({ children, href }) => href && /^https?:\/\//u.test(href)
    ? <a href={href} rel="noreferrer" target="_blank">{children}</a>
    : <span>{children}</span>,
  img: ({ alt, src }) => typeof src === "string" && /^https?:\/\//u.test(src)
    ? <a href={src} rel="noreferrer" target="_blank">{alt || "Image"}</a>
    : <span>{alt}</span>,
};

function MarkdownBody({ text }: { text: string }) {
  return <div className="automationRun__message pullRequestDetail__markdown">
    <Markdown components={markdownComponents} skipHtml>{text}</Markdown>
  </div>;
}

function Timestamp({ value }: { value: string }) {
  return <time dateTime={value} title={new Date(value).toLocaleString()}>{relativeTime(value)}</time>;
}

function Person({ person }: { person: PullRequestPerson | null }) {
  return <span className="pullRequestDetail__person">
    {person?.avatarUrl ? <img alt="" src={person.avatarUrl} /> : <span aria-hidden="true" className="pullRequestDetail__avatar" />}
    <strong>{person?.login ?? "Unknown"}</strong>
  </span>;
}

function ConversationEntry({ entry }: { entry: PullRequestConversationEntry }) {
  return <article className="automationRun__card pullRequestDetail__comment">
    <header>
      <Person person={entry.author} />
      <span className={entry.kind === "review" ? `pullRequestDetail__review--${entry.state}` : undefined}>{conversationAction(entry)}</span>
      <Timestamp value={entry.createdAt} />
      <span className="automationCreate__spacer" />
      <a aria-label="Open on GitHub" href={entry.url} rel="noreferrer" target="_blank"><ArrowUpRightIcon size={12} /></a>
    </header>
    {entry.body ? <MarkdownBody text={entry.body} /> : null}
    {entry.kind === "review" && entry.comments.length > 0
      ? <ul className="pullRequestDetail__inline">
          {entry.comments.map((comment) => <li key={comment.id}>
            <a className="pullRequestDetail__path" href={comment.url} rel="noreferrer" target="_blank">
              {comment.line ? `${comment.path}:${comment.line}` : comment.path}
            </a>
            <MarkdownBody text={comment.body} />
          </li>)}
        </ul>
      : null}
  </article>;
}

function CommitRow({ commit }: { commit: PullRequestCommit }) {
  const { description, title } = commitMessageParts(commit.message);
  return <li className="pullRequestDetail__commit">
    <GitCommitIcon aria-hidden="true" size={16} />
    <div>
      <strong title={description || undefined}>{title}</strong>
      <small>
        {commit.author?.login ?? commit.authorName ?? "Unknown"}
        {commit.committedAt ? <> · <Timestamp value={commit.committedAt} /></> : null}
      </small>
    </div>
    <a className="pullRequestDetail__sha" href={commit.url} rel="noreferrer" target="_blank">{shortSha(commit.sha)}</a>
  </li>;
}

export function PullRequestDetailPage() {
  const { pullRequestId } = useParams();
  if (!pullRequestId) return <Navigate replace to="/pull-requests" />;
  return <PullRequestDetailContent key={pullRequestId} pullRequestId={pullRequestId} />;
}

function PullRequestDetailContent({ pullRequestId }: { pullRequestId: string }) {
  const [detail, setDetail] = useState<AutomationPullRequestDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<AutomationPullRequestFiles | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [diffStyle, setDiffStyle] = useState<"split" | "unified">("unified");
  const request = useRef(0);
  const navigate = useNavigate();
  const activeTab = useMatch("/pull-requests/:pullRequestId/files") ? "files" : "overview";
  useDocumentTitle(detail ? pullRequestTitle(detail.github ?? detail.pullRequest) : "Pull request");

  const load = useCallback(async () => {
    const generation = ++request.current;
    try {
      const loaded = await fetchPullRequest(pullRequestId);
      if (request.current !== generation) return;
      setDetail(loaded);
      setError(null);
    } catch (cause) {
      if (request.current !== generation) return;
      const message = cause instanceof Error ? cause.message : "Unable to load the pull request";
      if (message === "Pull request not found") setMissing(true);
      else setError(message);
    }
  }, [pullRequestId]);

  useEffect(() => {
    void Promise.resolve().then(load);
    return () => { request.current += 1; };
  }, [load]);

  // The changed files load the first time the tab opens.
  const loadFiles = useCallback(async () => {
    try {
      setFiles(await fetchPullRequestFiles(pullRequestId));
      setFilesError(null);
    } catch (cause) {
      setFilesError(cause instanceof Error ? cause.message : "Unable to load the changed files");
    }
  }, [pullRequestId]);

  const needsFiles = activeTab === "files" && files === null && filesError === null;
  useEffect(() => {
    if (needsFiles) void Promise.resolve().then(loadFiles);
  }, [loadFiles, needsFiles]);

  if (missing) return <Navigate replace to="/pull-requests" />;
  if (!detail) {
    return <AppShell active="pull-requests" redesigned density="create">
      {error
        ? <div className="automationRun__loading" role="alert"><p>{error}</p><button className="automationCreate__secondary" onClick={() => { setError(null); void load(); }} type="button">Retry</button></div>
        : <PullRequestDetailSkeleton />}
    </AppShell>;
  }

  const { github, githubError, pullRequest } = detail;
  return <AppShell active="pull-requests" redesigned density="create">
    <div className={`automationCreate pullRequestDetail${activeTab === "files" ? " pullRequestDetail--files" : ""}`}>
      <header className="automationCreate__header">
        <nav aria-label="Breadcrumb" className="automationCreate__breadcrumb">
          <Link to="/pull-requests">Pull requests</Link><span aria-hidden="true">›</span>
          <span aria-current="page">{pullRequestReference(pullRequest)}</span>
        </nav>
        <div className="automationCreate__titleRow">
          <h1>{pullRequestTitle(github ?? pullRequest)}</h1>
          <span className="automationCreate__spacer" />
          {github ? <PullRequestStatus state={github.state} /> : null}
          <a className="automationRun__button" href={github?.url ?? pullRequest.url} rel="noreferrer" target="_blank">View on GitHub<ArrowUpRightIcon size={12} /></a>
        </div>
        <p className="pullRequestDetail__meta">
          <span>Opened by <Link to={`/automations/${pullRequest.automationId}/runs/${pullRequest.runId}`}>{pullRequest.automationName}</Link> <Timestamp value={pullRequest.createdAt} /></span>
          {github ? <>
            <span><code>{github.headBranch}</code> into <code>{github.baseBranch}</code></span>
            <span>{lineCountLabel(github.additions, github.deletions, github.changedFiles)}</span>
          </> : null}
        </p>
        {github ? <div className="automationCreate__tabs" role="tablist" aria-label="Pull request sections">
          <button aria-selected={activeTab === "overview"} onClick={() => { if (activeTab !== "overview") navigate(`/pull-requests/${pullRequestId}`); }} role="tab" type="button">Overview</button>
          <button aria-selected={activeTab === "files"} onClick={() => { if (activeTab !== "files") navigate(`/pull-requests/${pullRequestId}/files`); }} role="tab" type="button">Files changed <small>{github.changedFiles.toLocaleString()}</small></button>
        </div> : null}
      </header>
      {githubError ? <p className="automationRun__failure" role="alert">{githubError}</p> : null}
      {github && activeTab === "files" ? <section aria-label="Files changed" className="pullRequestDetail__section">
        {filesError || files?.githubError
          ? <div className="automationRun__loading" role="alert"><p>{filesError ?? files?.githubError}</p><button className="automationCreate__secondary" onClick={() => { setFiles(null); setFilesError(null); }} type="button">Retry</button></div>
          : files?.files ? <>
              <div className="pullRequestFiles__toolbar">
                <span>{filesChangedLabel(files.files)}{files.files.length < github.changedFiles ? ` · GitHub lists the first ${files.files.length.toLocaleString()}` : ""}</span>
                <SegmentedControl aria-label="Diff layout" onChange={setDiffStyle} options={[{ label: "Unified", value: "unified" }, { label: "Split", value: "split" }]} value={diffStyle} />
              </div>
              <Suspense fallback={<p className="pullRequestDetail__empty" role="status">Loading diffs…</p>}>
                <PullRequestFiles diffStyle={diffStyle} files={files.files} url={github.url} />
              </Suspense>
            </>
          : <p className="pullRequestDetail__empty" role="status">Loading changed files…</p>}
      </section> : null}
      {github && activeTab === "overview" ? <>
        <section aria-labelledby="pull-request-description" className="pullRequestDetail__section">
          <h2 id="pull-request-description">Description</h2>
          <article className="automationRun__card pullRequestDetail__card">
            {github.body.trim() ? <MarkdownBody text={github.body} /> : <p className="pullRequestDetail__empty">No description provided.</p>}
          </article>
        </section>
        <section aria-labelledby="pull-request-comments" className="pullRequestDetail__section">
          <h2 id="pull-request-comments">Comments <small>{github.conversation.length}</small></h2>
          {github.conversation.length === 0
            ? <p className="pullRequestDetail__empty">No comments yet.</p>
            : github.conversation.map((entry) => <ConversationEntry entry={entry} key={`${entry.kind}-${entry.id}`} />)}
        </section>
        <section aria-labelledby="pull-request-commits" className="pullRequestDetail__section">
          <h2 id="pull-request-commits">Commits <small>{github.commits.length}</small></h2>
          {github.commits.length === 0
            ? <p className="pullRequestDetail__empty">No commits.</p>
            : <ol className="automationRun__card pullRequestDetail__commits">
                {github.commits.map((commit) => <CommitRow commit={commit} key={commit.sha} />)}
              </ol>}
        </section>
      </> : null}
    </div>
  </AppShell>;
}
