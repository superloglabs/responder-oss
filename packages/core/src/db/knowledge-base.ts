import { and, asc, eq } from "drizzle-orm";
import type {
  CodebaseKnowledgeContent,
  CodebaseKnowledgeRepositoryRevision,
} from "../knowledge-base.js";
import { getDatabase } from "./client.js";
import {
  agentConfigVersions,
  agents,
  agentVersionRepositories,
  codebaseKnowledgeBases,
  integrationAccounts,
  repositories,
} from "./schema.js";

export interface CodebaseKnowledgeRefreshTarget {
  defaultBranch: string;
  fullName: string;
  installationId: number;
  organizationId: string;
  private: boolean;
  repositoryId: string;
}

const refreshTargetSelection = {
  defaultBranch: repositories.defaultBranch,
  fullName: repositories.fullName,
  installationId: integrationAccounts.externalAccountId,
  organizationId: integrationAccounts.organizationId,
  private: repositories.private,
  repositoryId: repositories.id,
};

function parseRefreshTarget(
  row: Omit<CodebaseKnowledgeRefreshTarget, "installationId"> & {
    installationId: string;
  },
): CodebaseKnowledgeRefreshTarget {
  const installationId = Number(row.installationId);
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    throw new Error(`GitHub repository ${row.fullName} has an invalid installation`);
  }
  return { ...row, installationId };
}

function activeRepositoryCondition() {
  return and(
    eq(agentConfigVersions.id, agents.activeVersionId),
    eq(agentVersionRepositories.agentConfigVersionId, agentConfigVersions.id),
  );
}

function availableGitHubRepositoryCondition() {
  return and(
    eq(integrationAccounts.provider, "github"),
    eq(integrationAccounts.status, "connected"),
    eq(repositories.available, true),
  );
}

export async function getCodebaseKnowledgeRefreshTarget(input: {
  organizationId: string;
  repositoryId: string;
}): Promise<CodebaseKnowledgeRefreshTarget | null> {
  const rows = await getDatabase()
    .selectDistinct(refreshTargetSelection)
    .from(repositories)
    .innerJoin(
      integrationAccounts,
      eq(integrationAccounts.id, repositories.integrationAccountId),
    )
    .innerJoin(
      agentVersionRepositories,
      eq(agentVersionRepositories.repositoryId, repositories.id),
    )
    .innerJoin(
      agentConfigVersions,
      eq(agentConfigVersions.id, agentVersionRepositories.agentConfigVersionId),
    )
    .innerJoin(agents, eq(agents.id, agentConfigVersions.agentId))
    .where(
      and(
        eq(repositories.id, input.repositoryId),
        eq(integrationAccounts.organizationId, input.organizationId),
        eq(agents.purpose, "standard"),
        activeRepositoryCondition(),
        availableGitHubRepositoryCondition(),
      ),
    )
    .limit(1);
  return rows[0] ? parseRefreshTarget(rows[0]) : null;
}

export async function listCodebaseKnowledgeRefreshTargetsForAgent(input: {
  agentId: string;
  organizationId: string;
}): Promise<CodebaseKnowledgeRefreshTarget[]> {
  const rows = await getDatabase()
    .selectDistinct(refreshTargetSelection)
    .from(repositories)
    .innerJoin(
      integrationAccounts,
      eq(integrationAccounts.id, repositories.integrationAccountId),
    )
    .innerJoin(
      agentVersionRepositories,
      eq(agentVersionRepositories.repositoryId, repositories.id),
    )
    .innerJoin(
      agentConfigVersions,
      eq(agentConfigVersions.id, agentVersionRepositories.agentConfigVersionId),
    )
    .innerJoin(agents, eq(agents.id, agentConfigVersions.agentId))
    .where(
      and(
        eq(agents.id, input.agentId),
        eq(integrationAccounts.organizationId, input.organizationId),
        eq(agents.purpose, "standard"),
        activeRepositoryCondition(),
        availableGitHubRepositoryCondition(),
      ),
    );
  return rows.map(parseRefreshTarget);
}

export async function listCodebaseKnowledgeRefreshTargets(): Promise<
  CodebaseKnowledgeRefreshTarget[]
> {
  const rows = await getDatabase()
    .selectDistinct(refreshTargetSelection)
    .from(repositories)
    .innerJoin(
      integrationAccounts,
      eq(integrationAccounts.id, repositories.integrationAccountId),
    )
    .innerJoin(
      agentVersionRepositories,
      eq(agentVersionRepositories.repositoryId, repositories.id),
    )
    .innerJoin(
      agentConfigVersions,
      eq(agentConfigVersions.id, agentVersionRepositories.agentConfigVersionId),
    )
    .innerJoin(agents, eq(agents.id, agentConfigVersions.agentId))
    .where(
      and(
        eq(agents.enabled, true),
        eq(agents.purpose, "standard"),
        activeRepositoryCondition(),
        availableGitHubRepositoryCondition(),
      ),
    );
  return rows.map(parseRefreshTarget);
}

export async function markCodebaseKnowledgeQueued(
  target: CodebaseKnowledgeRefreshTarget,
): Promise<void> {
  const now = new Date();
  await getDatabase()
    .insert(codebaseKnowledgeBases)
    .values({
      repositoryId: target.repositoryId,
      status: "queued",
      requestedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: codebaseKnowledgeBases.repositoryId,
      set: {
        failureReason: null,
        requestedAt: now,
        status: "queued",
        updatedAt: now,
      },
    });
}

export async function markCodebaseKnowledgeObsolete(
  repositoryId: string,
): Promise<void> {
  await getDatabase()
    .update(codebaseKnowledgeBases)
    .set({
      failureReason: "Repository is no longer available",
      status: "failed",
      updatedAt: new Date(),
    })
    .where(eq(codebaseKnowledgeBases.repositoryId, repositoryId));
}

export async function markCodebaseKnowledgeGenerating(
  target: CodebaseKnowledgeRefreshTarget,
): Promise<boolean> {
  const rows = await getDatabase()
    .update(codebaseKnowledgeBases)
    .set({ status: "generating", failureReason: null, updatedAt: new Date() })
    .where(eq(codebaseKnowledgeBases.repositoryId, target.repositoryId))
    .returning({ repositoryId: codebaseKnowledgeBases.repositoryId });
  return rows.length > 0;
}

export async function markCodebaseKnowledgeCurrent(input: {
  checkedAt?: Date;
  repositoryId: string;
}): Promise<void> {
  const checkedAt = input.checkedAt ?? new Date();
  await getDatabase()
    .update(codebaseKnowledgeBases)
    .set({
      status: "ready",
      checkedAt,
      failureReason: null,
      updatedAt: checkedAt,
    })
    .where(eq(codebaseKnowledgeBases.repositoryId, input.repositoryId));
}

export async function completeCodebaseKnowledgeGeneration(input: {
  content: CodebaseKnowledgeContent;
  repositoryId: string;
  repositoryRevision: CodebaseKnowledgeRepositoryRevision;
}): Promise<void> {
  const now = new Date();
  await getDatabase()
    .update(codebaseKnowledgeBases)
    .set({
      checkedAt: now,
      diagrams: input.content.diagrams,
      documents: input.content.documents,
      failureReason: null,
      generatedAt: now,
      overview: input.content.overview,
      repositoryRevisions: [input.repositoryRevision],
      status: "ready",
      updatedAt: now,
    })
    .where(eq(codebaseKnowledgeBases.repositoryId, input.repositoryId));
}

export async function failCodebaseKnowledgeGeneration(input: {
  failureReason: string;
  repositoryId: string;
}): Promise<void> {
  await getDatabase()
    .update(codebaseKnowledgeBases)
    .set({
      failureReason: input.failureReason.slice(0, 2_000),
      status: "failed",
      updatedAt: new Date(),
    })
    .where(eq(codebaseKnowledgeBases.repositoryId, input.repositoryId));
}

const knowledgeSelection = {
  status: codebaseKnowledgeBases.status,
  overview: codebaseKnowledgeBases.overview,
  documents: codebaseKnowledgeBases.documents,
  diagrams: codebaseKnowledgeBases.diagrams,
  repositoryRevisions: codebaseKnowledgeBases.repositoryRevisions,
  failureReason: codebaseKnowledgeBases.failureReason,
  requestedAt: codebaseKnowledgeBases.requestedAt,
  checkedAt: codebaseKnowledgeBases.checkedAt,
  generatedAt: codebaseKnowledgeBases.generatedAt,
  updatedAt: codebaseKnowledgeBases.updatedAt,
};

const repositoryKnowledgeSelection = {
  repositoryId: repositories.id,
  fullName: repositories.fullName,
  defaultBranch: repositories.defaultBranch,
  private: repositories.private,
  ...knowledgeSelection,
};

function mapRepositoryKnowledge(row: Awaited<ReturnType<
  typeof selectRepositoryKnowledgeRows
>>[number]) {
  return {
    repository: {
      id: row.repositoryId,
      defaultBranch: row.defaultBranch,
      fullName: row.fullName,
      private: row.private,
    },
    knowledge: row.status === null
      ? null
      : {
          status: row.status,
          overview: row.overview,
          documents: row.documents ?? [],
          diagrams: row.diagrams ?? [],
          repositoryRevisions: row.repositoryRevisions ?? [],
          failureReason: row.failureReason,
          requestedAt: row.requestedAt!,
          checkedAt: row.checkedAt,
          generatedAt: row.generatedAt,
          updatedAt: row.updatedAt!,
        },
  };
}

function selectRepositoryKnowledgeRows(
  organizationId: string,
  repositoryId?: string,
) {
  return getDatabase()
    .selectDistinct(repositoryKnowledgeSelection)
    .from(repositories)
    .innerJoin(
      integrationAccounts,
      eq(integrationAccounts.id, repositories.integrationAccountId),
    )
    .innerJoin(
      agentVersionRepositories,
      eq(agentVersionRepositories.repositoryId, repositories.id),
    )
    .innerJoin(
      agentConfigVersions,
      eq(agentConfigVersions.id, agentVersionRepositories.agentConfigVersionId),
    )
    .innerJoin(agents, eq(agents.id, agentConfigVersions.agentId))
    .leftJoin(
      codebaseKnowledgeBases,
      eq(codebaseKnowledgeBases.repositoryId, repositories.id),
    )
    .where(
      and(
        eq(integrationAccounts.organizationId, organizationId),
        repositoryId ? eq(repositories.id, repositoryId) : undefined,
        eq(agents.purpose, "standard"),
        activeRepositoryCondition(),
        availableGitHubRepositoryCondition(),
      ),
    )
    .orderBy(asc(repositories.fullName));
}

export async function listCodebaseKnowledgeRepositories(organizationId: string) {
  const rows = await selectRepositoryKnowledgeRows(organizationId);
  return rows.map(mapRepositoryKnowledge);
}

export async function getCodebaseKnowledgeRepository(input: {
  organizationId: string;
  repositoryId: string;
}) {
  const rows = await selectRepositoryKnowledgeRows(
    input.organizationId,
    input.repositoryId,
  );
  const row = rows[0];
  return row ? mapRepositoryKnowledge(row) : null;
}

export async function listRuntimeCodebaseKnowledge(agentConfigVersionId: string) {
  const rows = await getDatabase()
    .select({
      repositoryId: repositories.id,
      repository: repositories.fullName,
      ...knowledgeSelection,
    })
    .from(agentConfigVersions)
    .innerJoin(agents, eq(agents.id, agentConfigVersions.agentId))
    .innerJoin(
      agentVersionRepositories,
      eq(
        agentVersionRepositories.agentConfigVersionId,
        agentConfigVersions.id,
      ),
    )
    .innerJoin(
      repositories,
      eq(repositories.id, agentVersionRepositories.repositoryId),
    )
    .innerJoin(
      integrationAccounts,
      and(
        eq(integrationAccounts.id, repositories.integrationAccountId),
        eq(integrationAccounts.organizationId, agents.organizationId),
      ),
    )
    .innerJoin(
      codebaseKnowledgeBases,
      eq(codebaseKnowledgeBases.repositoryId, repositories.id),
    )
    .where(
      and(
        eq(agentConfigVersions.id, agentConfigVersionId),
        availableGitHubRepositoryCondition(),
      ),
    );
  return rows.filter((knowledge) => knowledge.documents.length > 0);
}

export async function getRepositoryCodebaseKnowledge(repositoryId: string) {
  const rows = await getDatabase()
    .select(knowledgeSelection)
    .from(codebaseKnowledgeBases)
    .where(eq(codebaseKnowledgeBases.repositoryId, repositoryId))
    .limit(1);
  return rows[0] ?? null;
}
