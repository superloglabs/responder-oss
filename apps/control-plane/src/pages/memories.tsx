import { DownloadSimpleIcon, PlusIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { relativeTime } from "../agents-api";
import { AppShell } from "../components/app-shell";
import { CopyPromptButton } from "../components/copy-prompt-button";
import { NavigationIcon } from "../components/navigation-icon";
import { AutomationListSkeleton } from "../components/screen-skeletons";
import { CodeBlock, DataTable, Tabs } from "../design-system";
import { mcpServerUrl } from "../mcp-connection-snippets";
import { fetchMemories, type MemoryListItem } from "../memories-api";
import { memoryImportPrompt, memoryImportSetups, type MemoryImportClient } from "../memory-import";
import { useDocumentTitle } from "../use-document-title";
import "./memories.css";

const typeLabels: Record<MemoryListItem["type"], string> = {
  feedback: "Feedback",
  project: "Project",
  reference: "Reference",
  user: "User",
};

function MemoryImportGuide() {
  const setups = memoryImportSetups(mcpServerUrl(window.location.origin));
  const [client, setClient] = useState<MemoryImportClient>("claude-code");
  const setup = setups.find((option) => option.value === client) ?? setups[0]!;
  return (
    <section aria-labelledby="memory-import" className="memoryImport">
      <div className="memoryImport__intro">
        <h2 id="memory-import">Import from Claude Code or Codex</h2>
        <p>
          Your coding agent reads its own memories for this project and imports the
          ones your team should share. In Conductor, run these steps in a workspace
          for the project.
        </p>
      </div>
      <ol className="memoryImport__steps">
        <li>
          <h3>Connect your agent to Superlog</h3>
          <Tabs
            aria-label="Coding agent"
            onChange={setClient}
            options={setups.map(({ label, value }) => ({ label, value }))}
            value={client}
          />
          <div aria-label={setup.label} className="memoryImport__panel" role="tabpanel">
            <CodeBlock code={setup.snippet} language="bash" />
            <p>{setup.signIn} For another client, see <Link to="/settings/mcp">MCP settings</Link>.</p>
          </div>
        </li>
        <li>
          <h3>Give it the import prompt</h3>
          <p>
            Start a session in the project&apos;s folder, so the agent finds that
            project&apos;s memories, and paste this prompt. It leaves out personal
            preferences and credentials, and asks before it changes a memory that
            already exists.
          </p>
          <div className="memoryImport__prompt">
            <pre>{memoryImportPrompt}</pre>
            <CopyPromptButton prompt={() => memoryImportPrompt} />
          </div>
        </li>
        <li>
          <h3>Check what it imported</h3>
          <p>
            Imported memories appear on this page. Open one to correct or delete it.
            Runs read memories and never change them.
          </p>
        </li>
      </ol>
    </section>
  );
}

export function MemoriesPage() {
  const [memories, setMemories] = useState<MemoryListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const navigate = useNavigate();
  useDocumentTitle("Memory");

  useEffect(() => {
    let cancelled = false;
    void fetchMemories()
      .then((items) => { if (!cancelled) setMemories(items); })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Unable to load memories");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const empty = !loading && !error && memories.length === 0;

  return (
    <AppShell active="memory" redesigned>
      <header className="workspaceHeading">
        <h1><NavigationIcon section="memory" />Memory</h1>
        <div className="workspaceHeading__actions">
          {empty ? null : (
            <button
              aria-expanded={showImport}
              className="dsButton dsButton--secondary dsButton--small"
              onClick={() => setShowImport((current) => !current)}
              type="button"
            >
              <DownloadSimpleIcon aria-hidden="true" size={14} />Import
            </button>
          )}
          <Link className="dsButton dsButton--primary dsButton--small" to="/memory/new">
            <PlusIcon aria-hidden="true" size={14} />New memory
          </Link>
        </div>
      </header>
      {error ? <p className="formError" role="alert">{error}</p> : null}
      {loading ? (
        <AutomationListSkeleton />
      ) : (
        <>
          {empty ? (
            <section className="emptyState emptyState--list memoriesEmpty">
              <h2>No memories yet</h2>
              <p>
                Memories are facts your team saves for agents, such as how
                production is set up and what caused past incidents. Every
                automation run and tag mode thread reads them.
              </p>
            </section>
          ) : null}
          {empty || showImport ? <MemoryImportGuide /> : null}
          {memories.length > 0 ? (
            <section aria-label="Memories" className="agentListTable">
              <DataTable<MemoryListItem>
                aria-label="Workspace memories"
                variant="workspace"
                columns={[
                  {
                    header: "Memory",
                    key: "memory",
                    render: (memory) => (
                      <Link className="agentTableTitle" to={`/memory/${memory.id}`}>
                        <strong>{memory.name}</strong>
                        <small>{memory.description}</small>
                      </Link>
                    ),
                    width: "58%",
                  },
                  {
                    header: "Type",
                    key: "type",
                    render: (memory) => <span className="agentTableCell">{typeLabels[memory.type]}</span>,
                    width: "12%",
                  },
                  {
                    header: "Saved by",
                    key: "updatedBy",
                    render: (memory) => <span className="agentTableCell">{memory.updatedBy?.name ?? "Removed member"}</span>,
                    width: "16%",
                  },
                  {
                    header: "Updated",
                    key: "updated",
                    render: (memory) => (
                      <time className="agentTableCell" dateTime={memory.updatedAt} title={new Date(memory.updatedAt).toLocaleString()}>
                        {relativeTime(memory.updatedAt)}
                      </time>
                    ),
                    width: "14%",
                  },
                ]}
                getRowKey={(memory) => memory.id}
                onRowClick={(memory) => navigate(`/memory/${memory.id}`)}
                rows={memories}
              />
            </section>
          ) : null}
        </>
      )}
    </AppShell>
  );
}
