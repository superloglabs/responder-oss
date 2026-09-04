import { describe, expect, it } from "vitest";
import {
  createCodebaseKnowledgeTools,
  listCodebaseKnowledgePage,
  searchCodebaseKnowledge,
  type RuntimeCodebaseKnowledge,
} from "./codebase-knowledge-tools.js";

const knowledge: RuntimeCodebaseKnowledge = {
  checkedAt: new Date("2026-09-04T03:00:00.000Z"),
  diagrams: [{
    slug: "request-flow",
    title: "Request flow",
    summary: "How HTTP requests reach storage.",
    d2: "browser: Browser\napi: API\nbrowser -> api: HTTPS",
    sourcePaths: ["acme/service/src/app.ts"],
  }],
  documents: [{
    slug: "background-jobs",
    title: "Background jobs",
    summary: "How durable work is processed.",
    markdown: "# Background jobs\n\nThe worker claims jobs from pg-boss.",
    sourcePaths: ["acme/service/src/worker.ts"],
  }],
  generatedAt: new Date("2026-09-04T02:00:00.000Z"),
  overview: "Service map",
  repository: "acme/service",
  repositoryId: "30000000-0000-4000-8000-000000000000",
  repositoryRevisions: [{
    branch: "main",
    repository: "acme/service",
    sha: "a".repeat(40),
  }],
  status: "ready",
};

describe("codebase knowledge investigation tools", () => {
  it("does not expose tools before a snapshot exists", () => {
    expect(createCodebaseKnowledgeTools([])).toEqual([]);
  });

  it("searches documents and diagrams and reads one bounded item", async () => {
    expect(searchCodebaseKnowledge([knowledge], "pg-boss")).toEqual([
      expect.objectContaining({
        kind: "document",
        repository: "acme/service",
        slug: "background-jobs",
      }),
    ]);
    const tools = createCodebaseKnowledgeTools([knowledge]);
    expect(tools.map((candidate) => candidate.name)).toEqual([
      "list_codebase_knowledge",
      "search_codebase_knowledge",
      "read_codebase_knowledge",
    ]);
    await expect(
      tools[2]!.invoke(
        undefined as never,
        JSON.stringify({
          kind: "diagram",
          repository: "acme/service",
          slug: "request-flow",
        }),
      ),
    ).resolves.toMatchObject({
      kind: "diagram",
      repository: "acme/service",
      d2: expect.stringContaining("browser -> api"),
    });
  });

  it("paginates repository discovery and entries", () => {
    expect(listCodebaseKnowledgePage([knowledge, {
      ...knowledge,
      repository: "acme/web",
      repositoryId: "40000000-0000-4000-8000-000000000000",
    }], { limit: 1 })).toMatchObject({
      nextCursor: 1,
      repositories: [{ repository: "acme/service" }],
    });
    expect(listCodebaseKnowledgePage([knowledge], {
      limit: 1,
      repository: "acme/service",
    })).toMatchObject({
      entries: [{ kind: "document", slug: "background-jobs" }],
      nextCursor: 1,
    });
  });
});
