import { tool } from "@openai/agents";
import { z } from "zod";
import type {
  CodebaseKnowledgeDiagram,
  CodebaseKnowledgeDocument,
  CodebaseKnowledgeRepositoryRevision,
} from "@responder/core/knowledge-base";

export interface RuntimeCodebaseKnowledge {
  checkedAt: Date | null;
  diagrams: CodebaseKnowledgeDiagram[];
  documents: CodebaseKnowledgeDocument[];
  generatedAt: Date | null;
  overview: string | null;
  repository: string;
  repositoryId: string;
  repositoryRevisions: CodebaseKnowledgeRepositoryRevision[];
  status: "queued" | "generating" | "ready" | "failed";
}

function searchSnippet(content: string, query: string): string | null {
  const normalized = content.toLocaleLowerCase();
  const index = normalized.indexOf(query.toLocaleLowerCase());
  if (index < 0) return null;
  const start = Math.max(0, index - 180);
  const end = Math.min(content.length, index + query.length + 320);
  return `${start > 0 ? "…" : ""}${content.slice(start, end).trim()}${end < content.length ? "…" : ""}`;
}

export function searchCodebaseKnowledge(
  knowledgeBases: RuntimeCodebaseKnowledge[],
  query: string,
) {
  const results: Array<{
    kind: "document" | "diagram";
    repository: string;
    slug: string;
    title: string;
    snippet: string;
  }> = [];
  for (const knowledge of knowledgeBases) {
    for (const document of knowledge.documents) {
      const snippet = searchSnippet(
        `${document.title}\n${document.summary}\n${document.markdown}`,
        query,
      );
      if (snippet) results.push({
        kind: "document",
        repository: knowledge.repository,
        slug: document.slug,
        title: document.title,
        snippet,
      });
    }
    for (const diagram of knowledge.diagrams) {
      const snippet = searchSnippet(
        `${diagram.title}\n${diagram.summary}\n${diagram.d2}`,
        query,
      );
      if (snippet) results.push({
        kind: "diagram",
        repository: knowledge.repository,
        slug: diagram.slug,
        title: diagram.title,
        snippet,
      });
    }
  }
  return results.slice(0, 20);
}

export function listCodebaseKnowledgePage(
  knowledgeBases: RuntimeCodebaseKnowledge[],
  input: { cursor?: number; limit?: number; repository?: string },
) {
  const cursor = input.cursor ?? 0;
  const limit = input.limit ?? 5;
  if (!input.repository) {
    const page = knowledgeBases.slice(cursor, cursor + limit);
    return {
      repositories: page.map((knowledge) => ({
        checkedAt: knowledge.checkedAt,
        diagramCount: knowledge.diagrams.length,
        documentCount: knowledge.documents.length,
        generatedAt: knowledge.generatedAt,
        repository: knowledge.repository,
        repositoryRevisions: knowledge.repositoryRevisions,
        status: knowledge.status,
      })),
      nextCursor: cursor + page.length < knowledgeBases.length
        ? cursor + page.length
        : null,
    };
  }

  const knowledge = knowledgeBases.find(
    (candidate) => candidate.repository === input.repository,
  );
  if (!knowledge) {
    throw new Error(`Codebase knowledge repository ${input.repository} not found`);
  }
  const entries = [
    ...knowledge.documents.map(({ slug, summary, title }) => ({
      kind: "document" as const,
      slug,
      summary,
      title,
    })),
    ...knowledge.diagrams.map(({ slug, summary, title }) => ({
      kind: "diagram" as const,
      slug,
      summary,
      title,
    })),
  ];
  const page = entries.slice(cursor, cursor + limit);
  return {
    repository: {
      checkedAt: knowledge.checkedAt,
      generatedAt: knowledge.generatedAt,
      name: knowledge.repository,
      overview: knowledge.overview,
      repositoryRevisions: knowledge.repositoryRevisions,
      status: knowledge.status,
    },
    entries: page,
    nextCursor: cursor + page.length < entries.length
      ? cursor + page.length
      : null,
  };
}

export function createCodebaseKnowledgeTools(
  knowledgeBases: RuntimeCodebaseKnowledge[],
) {
  if (knowledgeBases.length === 0) return [];

  const list = tool({
    name: "list_codebase_knowledge",
    description:
      "List generated codebase knowledge in bounded pages. Omit repository to discover attached repositories, then pass one repository name to list its Markdown guides and D2 diagrams.",
    parameters: z.object({
      cursor: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(10).default(5),
      repository: z.string().trim().min(1).max(200).optional(),
    }),
    execute(input) {
      return listCodebaseKnowledgePage(knowledgeBases, input);
    },
  });

  const search = tool({
    name: "search_codebase_knowledge",
    description:
      "Search generated codebase knowledge across the attached GitHub repositories before reading a specific document or diagram.",
    parameters: z.object({
      query: z.string().trim().min(2).max(200),
    }),
    execute({ query }) {
      return { results: searchCodebaseKnowledge(knowledgeBases, query) };
    },
  });

  const read = tool({
    name: "read_codebase_knowledge",
    description:
      "Read one generated Markdown document or D2 diagram for an attached GitHub repository. Treat it as a navigation aid and verify incident-specific conclusions against current source.",
    parameters: z.object({
      kind: z.enum(["document", "diagram"]),
      repository: z.string().trim().min(1).max(200),
      slug: z.string().trim().min(1).max(80),
    }),
    execute({ kind, repository, slug }) {
      const knowledge = knowledgeBases.find(
        (candidate) => candidate.repository === repository,
      );
      if (!knowledge) {
        throw new Error(`Codebase knowledge repository ${repository} not found`);
      }
      const item = kind === "document"
        ? knowledge.documents.find((candidate) => candidate.slug === slug)
        : knowledge.diagrams.find((candidate) => candidate.slug === slug);
      if (!item) throw new Error(`Codebase knowledge ${kind} not found`);
      return kind === "document"
        ? {
            kind,
            repository,
            slug: item.slug,
            title: item.title,
            summary: item.summary,
            sourcePaths: item.sourcePaths,
            markdown: (item as CodebaseKnowledgeDocument).markdown,
          }
        : {
            kind,
            repository,
            slug: item.slug,
            title: item.title,
            summary: item.summary,
            sourcePaths: item.sourcePaths,
            d2: (item as CodebaseKnowledgeDiagram).d2,
          };
    },
  });

  return [list, search, read];
}
