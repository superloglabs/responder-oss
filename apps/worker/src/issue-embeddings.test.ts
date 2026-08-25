import { describe, expect, it, vi } from "vitest";
import {
  embedNewIssues,
  rankIssueCandidates,
  searchCanonicalIssues,
} from "./issue-embeddings.js";

const createdAt = new Date("2026-08-05T08:00:00.000Z");

function candidate(input: {
  id: string;
  embedding: number[] | null;
  embeddingModel: string | null;
}) {
  return {
    id: input.id,
    title: `Issue ${input.id}`,
    description: "The route throws.",
    rootCause: "A code change removed the missing-value guard.",
    timeline: [{
      title: "Request reached the route",
      description: "The request reached the route without the required value.",
    }],
    severity: "SEV-2" as const,
    remediation: "Handle the missing value.",
    evidence: [],
    embedding: input.embedding,
    embeddingModel: input.embeddingModel,
    createdAt,
  };
}

describe("issue embeddings", () => {
  it("ranks only embeddings made with the same model", () => {
    expect(
      rankIssueCandidates(
        [
          candidate({
            id: "matching",
            embedding: [1, 0],
            embeddingModel: "openai/text-embedding-3-small",
          }),
          candidate({
            id: "different-model",
            embedding: [1, 0],
            embeddingModel: "another-model",
          }),
          candidate({
            id: "less-similar",
            embedding: [0, 1],
            embeddingModel: "openai/text-embedding-3-small",
          }),
        ],
        [1, 0],
        "openai/text-embedding-3-small",
        5,
      ).map((issue) => issue.id),
    ).toEqual(["matching", "less-similar"]);
  });

  it("uses OpenAI search embeddings while keeping the old stored model name", async () => {
    const create = vi.fn().mockResolvedValue({
      data: [{ embedding: [1, 0], index: 0 }],
    });
    const result = await searchCanonicalIssues(
      { organizationId: "organization-id", query: "broken route", limit: 5 },
      { OPENAI_API_KEY: "test-key" },
      {
        createOpenAI: () => ({ embeddings: { create } }) as never,
        listCandidates: vi.fn().mockResolvedValue([
          candidate({
            id: "existing",
            embedding: [1, 0],
            embeddingModel: "openai/text-embedding-3-small",
          }),
        ]),
        searchText: vi.fn().mockResolvedValue([]),
      },
    );

    expect(result.mode).toBe("semantic");
    expect(result.issues[0]?.id).toBe("existing");
    expect(create).toHaveBeenCalledWith({
      input: ["broken route"],
      model: "text-embedding-3-small",
    });
  });

  it("falls back to text search when embeddings are unavailable", async () => {
    const textMatch = candidate({
      id: "text-match",
      embedding: null,
      embeddingModel: null,
    });
    const searchText = vi.fn().mockResolvedValue([textMatch]);
    const result = await searchCanonicalIssues(
      { organizationId: "organization-id", query: "broken", limit: 5 },
      {},
      {
        createOpenAI: vi.fn() as never,
        listCandidates: vi.fn().mockResolvedValue([]),
        searchText,
      },
    );

    expect(result.mode).toBe("text");
    expect(result.issues[0]?.id).toBe("text-match");
  });

  it("creates search data for newly found issues", async () => {
    const create = vi.fn().mockResolvedValue({
      data: [{ embedding: [0.2, 0.8], index: 0 }],
    });
    await expect(
      embedNewIssues(
        [
          {
            title: "Broken route",
            description: "The route throws.",
            remediations: [{
              title: "Handle the missing value",
              description: "Handle the missing value.",
            }],
          },
        ],
        { OPENAI_API_KEY: "test-key" },
        {
          createOpenAI: () => ({ embeddings: { create } }) as never,
          listCandidates: vi.fn(),
          searchText: vi.fn(),
        },
      ),
    ).resolves.toEqual([
      {
        model: "openai/text-embedding-3-small",
        vector: [0.2, 0.8],
      },
    ]);
  });
});
