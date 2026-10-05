import { BookOpenTextIcon, PlusIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { relativeTime } from "../agents-api";
import { AppShell } from "../components/app-shell";
import { AutomationListSkeleton } from "../components/screen-skeletons";
import { DataTable } from "../design-system";
import { fetchSkills, type SkillListItem } from "../skills-api";
import { useDocumentTitle } from "../use-document-title";
import "./skills.css";

function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function SkillsPage() {
  const [skills, setSkills] = useState<SkillListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  useDocumentTitle("Skills");

  useEffect(() => {
    let cancelled = false;
    void fetchSkills()
      .then((items) => { if (!cancelled) setSkills(items); })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Unable to load skills");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  return (
    <AppShell active="skills" redesigned>
      <header className="workspaceHeading">
        <h1><BookOpenTextIcon aria-hidden="true" size={16} weight="fill" />Skills</h1>
        <Link className="dsButton dsButton--primary dsButton--small" to="/skills/new">
          <PlusIcon aria-hidden="true" size={14} />Create skill
        </Link>
      </header>
      {error ? <p className="formError" role="alert">{error}</p> : null}
      {loading ? (
        <AutomationListSkeleton />
      ) : skills.length === 0 ? (
        error ? null : (
          <section className="emptyState emptyState--list skillsEmpty">
            <h2>No skills yet</h2>
            <p>
              A skill gives automations instructions and reference files, such as
              an API&apos;s OpenAPI spec, and the secrets to call it. Add a skill to
              an automation from its connectors.
            </p>
            <Link className="dsButton dsButton--primary dsButton--medium" to="/skills/new">
              Create a skill
            </Link>
          </section>
        )
      ) : (
        <section aria-label="Skills" className="agentListTable">
          <DataTable<SkillListItem>
            aria-label="Workspace skills"
            variant="workspace"
            columns={[
              {
                header: "Skill",
                key: "skill",
                render: (skill) => (
                  <Link className="agentTableTitle" to={`/skills/${skill.id}`}>
                    <strong>{skill.name}</strong>
                    <small>{skill.description}</small>
                  </Link>
                ),
                width: "44%",
              },
              {
                header: "Files",
                key: "files",
                render: (skill) => <span className="agentTableCell">{skill.fileCount > 0 ? countLabel(skill.fileCount, "file") : "None"}</span>,
                width: "10%",
              },
              {
                header: "Secrets",
                key: "secrets",
                render: (skill) => (
                  <span className="agentTableCell" title={skill.secrets.map((secret) => secret.name).join(", ") || undefined}>
                    {skill.secrets.length > 0 ? skill.secrets.map((secret) => secret.name).join(", ") : "None"}
                  </span>
                ),
                width: "18%",
              },
              {
                header: "Used by",
                key: "automations",
                render: (skill) => (
                  <span className="agentTableCell" title={skill.automations.map((automation) => automation.name).join(", ") || undefined}>
                    {skill.automations.length > 0 ? countLabel(skill.automations.length, "automation") : "Not used"}
                  </span>
                ),
                width: "14%",
              },
              {
                header: "Updated",
                key: "updated",
                render: (skill) => (
                  <time className="agentTableCell" dateTime={skill.updatedAt} title={new Date(skill.updatedAt).toLocaleString()}>
                    {relativeTime(skill.updatedAt)}
                  </time>
                ),
                width: "14%",
              },
            ]}
            getRowKey={(skill) => skill.id}
            onRowClick={(skill) => navigate(`/skills/${skill.id}`)}
            rows={skills}
          />
        </section>
      )}
    </AppShell>
  );
}
