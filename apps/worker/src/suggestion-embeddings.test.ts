import { describe, expect, it, vi } from "vitest";
import {
  rankSuggestionCandidates,
  searchCanonicalSuggestions,
} from "./suggestion-embeddings.js";

const createdAt = new Date("2026-09-14T12:00:00.000Z");

function candidate(id: string, embedding: number[] | null, model: string | null) {
  return {
    id,
    title: `Suggestion ${id}.`,
    subtitle: "A missing measurement slowed the investigation.",
    detail: "## Detail\n\nAdd the measurement.",
    codeChange: null,
    embedding,
    embeddingModel: model,
    createdAt,
  };
}

describe("suggestion embeddings", () => {
  it("ranks only compatible embeddings and exposes no invented model fields", () => {
    const results = rankSuggestionCandidates(
      [
        candidate("best", [1, 0], "openai/text-embedding-3-small"),
        candidate("other-model", [1, 0], "other"),
        candidate("second", [0, 1], "openai/text-embedding-3-small"),
      ],
      [1, 0],
      "openai/text-embedding-3-small",
      5,
    );
    expect(results.map((result) => result.id)).toEqual(["best", "second"]);
    expect(results[0]).toEqual({
      id: "best",
      title: "Suggestion best.",
      subtitle: "A missing measurement slowed the investigation.",
      detail: "## Detail\n\nAdd the measurement.",
      codeChangeAvailable: false,
      similarity: 1,
      createdAt: createdAt.toISOString(),
    });
  });

  it("runs text search once when embedding creation fails", async () => {
    const searchText = vi.fn().mockResolvedValue([
      candidate("text", null, null),
    ]);

    await expect(searchCanonicalSuggestions(
      { organizationId: "org-1", query: "queue", limit: 5 },
      {},
      {
        createEmbedding: vi.fn().mockRejectedValue(new Error("unavailable")),
        listCandidates: vi.fn().mockResolvedValue([]),
        searchText,
      },
    )).resolves.toMatchObject({ mode: "text" });
    expect(searchText).toHaveBeenCalledTimes(1);
  });
});
