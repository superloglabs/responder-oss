import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  fetchCodebaseKnowledgeRepositories,
  relativeTime,
  type CodebaseKnowledgeBase,
  type CodebaseKnowledgeRepository,
} from "../agents-api";
import { AppShell } from "../components/app-shell";
import { AgentListSkeleton } from "../components/screen-skeletons";
import { Badge, DataTable } from "../design-system";
import { useDocumentTitle } from "../use-document-title";

function statusPresentation(knowledge: CodebaseKnowledgeBase | null) {
  switch (knowledge?.status) {
    case "queued":
      return { label: "Queued", tone: "warning" as const };
    case "generating":
      return { label: "Generating", tone: "info" as const };
    case "ready":
      return { label: "Current", tone: "live" as const };
    case "failed":
      return { label: "Refresh failed", tone: "danger" as const };
    default:
      return { label: "Not generated", tone: "neutral" as const };
  }
}

export function CodebaseKnowledgeIndexPage() {
  const [repositories, setRepositories] = useState<CodebaseKnowledgeRepository[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useDocumentTitle("Knowledge");

  useEffect(() => {
    let cancelled = false;
    void fetchCodebaseKnowledgeRepositories()
      .then((loadedRepositories) => {
        if (!cancelled) setRepositories(loadedRepositories);
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(caught instanceof Error
            ? caught.message
            : "Unable to load codebase knowledge");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <AppShell active="knowledge">
      <section className="pageHeading">
        <h1>Knowledge</h1>
      </section>

      {error ? <p className="formError">{error}</p> : null}
      {loading ? (
        <AgentListSkeleton />
      ) : error ? null : repositories.length === 0 ? (
        <section className="emptyState emptyState--list">
          <h2>No repository knowledge available</h2>
          <p>Attach a GitHub repository to an agent to build its knowledge base.</p>
          <Link
            className="dsButton dsButton--primary dsButton--medium"
            to="/agents"
          >
            View agents
          </Link>
        </section>
      ) : (
        <section aria-labelledby="knowledge-list-title" className="agentListTable">
          <h2 className="srOnly" id="knowledge-list-title">
            Repository knowledge bases
          </h2>
          <DataTable<CodebaseKnowledgeRepository>
            aria-label="Repository knowledge bases"
            columns={[
              {
                header: "Repository",
                key: "repository",
                render: ({ repository }) => (
                  <Link
                    className="agentTableTitle"
                    to={`/knowledge/${repository.id}`}
                  >
                    <strong>{repository.fullName}</strong>
                  </Link>
                ),
                width: "40%",
              },
              {
                header: "Branch",
                key: "branch",
                render: ({ repository }) => (
                  <span className="agentTableCell">{repository.defaultBranch}</span>
                ),
                width: "20%",
              },
              {
                header: "Snapshot",
                key: "snapshot",
                render: ({ knowledge }) => {
                  const status = statusPresentation(knowledge);
                  return <Badge tone={status.tone}>{status.label}</Badge>;
                },
                width: "18%",
              },
              {
                header: "Generated",
                key: "generated",
                render: ({ knowledge }) => (
                  <span className="agentTableCell">
                    {knowledge?.generatedAt ? relativeTime(knowledge.generatedAt) : "—"}
                  </span>
                ),
                width: "14%",
              },
              {
                align: "right",
                header: "",
                key: "open",
                render: ({ repository }) => (
                  <Link
                    aria-label={`Open ${repository.fullName} knowledge`}
                    className="dsButton dsButton--secondary dsButton--small"
                    to={`/knowledge/${repository.id}`}
                  >
                    Open
                  </Link>
                ),
                width: "8%",
              },
            ]}
            getRowKey={({ repository }) => repository.id}
            rows={repositories}
          />
        </section>
      )}
    </AppShell>
  );
}
