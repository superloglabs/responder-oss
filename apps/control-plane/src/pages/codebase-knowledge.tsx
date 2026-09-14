import { useCallback, useEffect, useMemo, useState } from "react";
import Markdown from "react-markdown";
import { Link, Navigate, useParams } from "react-router-dom";
import {
  fetchCodebaseKnowledgeRepository,
  refreshCodebaseKnowledge,
  relativeTime,
  type CodebaseKnowledgeBase,
  type CodebaseKnowledgeRepository,
} from "../agents-api";
import { AppShell } from "../components/app-shell";
import { CodebaseKnowledgeDiagram } from "../components/codebase-knowledge-diagram";
import { Badge, Button, Panel } from "../design-system";
import { useDocumentTitle } from "../use-document-title";

const refreshPollMs = 3_000;

function statusPresentation(status: CodebaseKnowledgeBase["status"]) {
  switch (status) {
    case "queued":
      return { label: "Queued", tone: "warning" as const };
    case "generating":
      return { label: "Generating", tone: "info" as const };
    case "ready":
      return { label: "Current", tone: "live" as const };
    case "failed":
      return { label: "Refresh failed", tone: "danger" as const };
  }
}

export function CodebaseKnowledgePage() {
  const { repositoryId } = useParams();
  return (
    <CodebaseKnowledgePageContent
      key={repositoryId ?? "missing"}
      repositoryId={repositoryId}
    />
  );
}

function CodebaseKnowledgePageContent({
  repositoryId,
}: {
  repositoryId: string | undefined;
}) {
  const [repository, setRepository] = useState<
    CodebaseKnowledgeRepository["repository"] | null
  >(null);
  const [knowledge, setKnowledge] = useState<CodebaseKnowledgeBase | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useDocumentTitle(
    repository ? `${repository.fullName} knowledge` : "Codebase knowledge",
  );

  const applyLoaded = useCallback((loaded: CodebaseKnowledgeRepository) => {
    setRepository(loaded.repository);
    setKnowledge(loaded.knowledge);
    setSelected((current) => {
      const stillExists = current && (
        current.startsWith("document:")
          ? loaded.knowledge?.documents.some(
              (item) => current === `document:${item.slug}`,
            )
          : loaded.knowledge?.diagrams.some(
              (item) => current === `diagram:${item.slug}`,
            )
      );
      return stillExists ? current : (loaded.knowledge?.documents[0]
        ? `document:${loaded.knowledge.documents[0].slug}`
        : loaded.knowledge?.diagrams[0]
          ? `diagram:${loaded.knowledge.diagrams[0].slug}`
          : null);
    });
  }, []);

  const load = useCallback(async (isCancelled: () => boolean = () => false) => {
    if (!repositoryId) return;
    const loaded = await fetchCodebaseKnowledgeRepository(repositoryId);
    if (!isCancelled()) applyLoaded(loaded);
  }, [applyLoaded, repositoryId]);

  useEffect(() => {
    if (!repositoryId) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void load(() => cancelled)
        .catch((caught: unknown) => {
          if (cancelled) return;
          const message = caught instanceof Error
            ? caught.message
            : "Unable to load codebase knowledge";
          if (message === "Repository not found") {
            setNotFound(true);
          }
          else setError(message);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [load, repositoryId]);

  useEffect(() => {
    if (knowledge?.status !== "queued" && knowledge?.status !== "generating") {
      return;
    }
    const timer = window.setInterval(() => {
      void load().catch(() => undefined);
    }, refreshPollMs);
    return () => window.clearInterval(timer);
  }, [knowledge?.status, knowledge?.updatedAt, load]);

  const activeItem = useMemo(() => {
    if (!knowledge || !selected) return null;
    const [kind, slug] = selected.split(":", 2);
    return kind === "document"
      ? knowledge.documents.find((item) => item.slug === slug) ?? null
      : knowledge.diagrams.find((item) => item.slug === slug) ?? null;
  }, [knowledge, selected]);

  async function requestRefresh() {
    if (!repositoryId || refreshing) return;
    setRefreshing(true);
    setError(null);
    try {
      await refreshCodebaseKnowledge(repositoryId);
      await load();
    } catch (caught) {
      setError(caught instanceof Error
        ? caught.message
        : "Unable to refresh codebase knowledge");
    } finally {
      setRefreshing(false);
    }
  }

  if (!repositoryId || notFound) {
    return <Navigate replace to="/knowledge" />;
  }
  if (loading) {
    return (
      <AppShell active="knowledge" density="compact">
        <section className="knowledgeLoading">Loading codebase knowledge…</section>
      </AppShell>
    );
  }
  if (!repository) {
    return (
      <AppShell active="knowledge" density="compact">
        <section className="emptyState">
          <h1>Unable to load codebase knowledge</h1>
          <p>{error ?? "Try again in a moment."}</p>
          <Link className="button button--secondary" to="/knowledge">
            Back to knowledge
          </Link>
        </section>
      </AppShell>
    );
  }

  const status = knowledge ? statusPresentation(knowledge.status) : null;
  const selectedKind = selected?.startsWith("diagram:") ? "diagram" : "document";

  return (
    <AppShell active="knowledge" density="compact">
      <section className="knowledgeHeading">
        <div>
          <Link className="knowledgeHeading__back" to="/knowledge">
            ← All knowledge
          </Link>
          <h1>{repository.fullName}</h1>
        </div>
        <div className="knowledgeHeading__actions">
          {status ? <Badge tone={status.tone}>{status.label}</Badge> : null}
          <Button
            loading={refreshing}
            onClick={() => void requestRefresh()}
            variant="secondary"
          >
            {knowledge ? "Refresh now" : "Generate knowledge base"}
          </Button>
        </div>
      </section>

      {error ? <p className="formError">{error}</p> : null}
      {knowledge?.failureReason ? (
        <p className="formError">
          The last refresh failed: {knowledge.failureReason}
        </p>
      ) : null}

      {!knowledge || (knowledge.documents.length === 0 && knowledge.diagrams.length === 0) ? (
        <Panel className="knowledgeEmpty" surface="base">
          <h2>
            {knowledge?.status === "queued" || knowledge?.status === "generating"
              ? "Building the first snapshot"
              : "No knowledge snapshot yet"}
          </h2>
          <p>
            Future daily checks regenerate them only when a repository changes.
          </p>
        </Panel>
      ) : (
        <div className="knowledgeWorkspace">
          <aside className="knowledgeNavigation" aria-label="Knowledge contents">
            <h2>Guides</h2>
            {knowledge.documents.map((document) => (
              <button
                className={selected === `document:${document.slug}` ? "isActive" : ""}
                key={document.slug}
                onClick={() => setSelected(`document:${document.slug}`)}
                type="button"
              >
                <strong>{document.title}</strong>
                <span>{document.summary}</span>
              </button>
            ))}
            <h2>Diagrams</h2>
            {knowledge.diagrams.map((diagram) => (
              <button
                className={selected === `diagram:${diagram.slug}` ? "isActive" : ""}
                key={diagram.slug}
                onClick={() => setSelected(`diagram:${diagram.slug}`)}
                type="button"
              >
                <strong>{diagram.title}</strong>
                <span>{diagram.summary}</span>
              </button>
            ))}
          </aside>

          <Panel className="knowledgeContent" surface="base">
            {activeItem ? (
              <>
                <header>
                  <span>{selectedKind === "diagram" ? "D2 diagram" : "Markdown guide"}</span>
                  <h2>{activeItem.title}</h2>
                  <p>{activeItem.summary}</p>
                </header>
                {selectedKind === "diagram" && "d2" in activeItem ? (
                  <>
                    <CodebaseKnowledgeDiagram source={activeItem.d2} />
                    <details className="knowledgeSource">
                      <summary>View D2 source</summary>
                      <pre><code>{activeItem.d2}</code></pre>
                    </details>
                  </>
                ) : "markdown" in activeItem ? (
                  <article className="knowledgeMarkdown">
                    <Markdown>{activeItem.markdown}</Markdown>
                  </article>
                ) : null}
                {activeItem.sourcePaths.length > 0 ? (
                  <footer className="knowledgePaths">
                    <strong>Primary sources</strong>
                    <ul>
                      {activeItem.sourcePaths.map((path) => <li key={path}><code>{path}</code></li>)}
                    </ul>
                  </footer>
                ) : null}
              </>
            ) : null}
          </Panel>
        </div>
      )}

      {knowledge?.repositoryRevisions.length ? (
        <section className="knowledgeRevisions">
          <h2>Snapshot revisions</h2>
          <ul>
            {knowledge.repositoryRevisions.map((revision) => (
              <li key={revision.repository}>
                <strong>{revision.repository}</strong>
                <span>{revision.branch} · {revision.sha.slice(0, 12)}</span>
              </li>
            ))}
          </ul>
          <p>
            {knowledge.generatedAt
              ? `Generated ${relativeTime(knowledge.generatedAt)}`
              : "Generation pending"}
            {knowledge.checkedAt ? ` · Heads checked ${relativeTime(knowledge.checkedAt)}` : ""}
          </p>
        </section>
      ) : null}
    </AppShell>
  );
}
