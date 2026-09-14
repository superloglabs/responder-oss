import {
  listSuggestionSearchCandidates,
  searchSuggestionsByText,
  suggestionEmbeddingText,
  type SuggestionEmbedding,
} from "@responder/core/db/suggestions";
import OpenAI from "openai";
import { cosineSimilarity, issueEmbeddingModel } from "./issue-embeddings.js";

type Candidate = Awaited<ReturnType<typeof listSuggestionSearchCandidates>>[number];

function serialize(candidate: Candidate, similarity: number | null) {
  return {
    id: candidate.id,
    title: candidate.title,
    subtitle: candidate.subtitle,
    detail: candidate.detail,
    codeChangeAvailable: Boolean(candidate.codeChange),
    similarity,
    createdAt: candidate.createdAt.toISOString(),
  };
}

export function rankSuggestionCandidates(
  candidates: Candidate[],
  queryEmbedding: number[],
  model: string,
  limit: number,
) {
  return candidates
    .filter(
      (candidate) =>
        candidate.embeddingModel === model &&
        candidate.embedding?.length === queryEmbedding.length &&
        candidate.embedding.every(Number.isFinite),
    )
    .map((candidate) =>
      serialize(candidate, cosineSimilarity(queryEmbedding, candidate.embedding!)),
    )
    .sort((left, right) => (right.similarity ?? -1) - (left.similarity ?? -1))
    .slice(0, limit);
}

async function createEmbedding(
  value: string,
  environment: NodeJS.ProcessEnv,
): Promise<SuggestionEmbedding> {
  const apiKey = environment.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required");
  const model = issueEmbeddingModel(environment);
  const response = await new OpenAI({ apiKey }).embeddings.create({
    input: [value],
    model: model.startsWith("openai/") ? model.slice("openai/".length) : model,
  });
  const vector = response.data[0]?.embedding;
  if (!vector) throw new Error("OpenAI returned an incomplete suggestion embedding response");
  return { model, vector };
}

export interface SuggestionSearchDependencies {
  createEmbedding: typeof createEmbedding;
  listCandidates: typeof listSuggestionSearchCandidates;
  searchText: typeof searchSuggestionsByText;
}

const defaultSearchDependencies: SuggestionSearchDependencies = {
  createEmbedding,
  listCandidates: listSuggestionSearchCandidates,
  searchText: searchSuggestionsByText,
};

export async function embedSuggestion(
  suggestion: { title: string; subtitle: string; detail: string },
  environment: NodeJS.ProcessEnv = process.env,
): Promise<SuggestionEmbedding | null> {
  try {
    return await createEmbedding(suggestionEmbeddingText(suggestion), environment);
  } catch {
    return null;
  }
}

export async function searchCanonicalSuggestions(
  input: { organizationId: string; query: string; limit: number },
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: SuggestionSearchDependencies = defaultSearchDependencies,
) {
  let embedding: SuggestionEmbedding;
  let candidates: Candidate[];
  try {
    [embedding, candidates] = await Promise.all([
      dependencies.createEmbedding(input.query, environment),
      dependencies.listCandidates(input.organizationId),
    ]);
  } catch {
    return {
      mode: "text" as const,
      suggestions: (await dependencies.searchText(
        input.organizationId,
        input.query,
        input.limit,
      )).map((candidate) => serialize(candidate, null)),
    };
  }
  const textMatches = await dependencies.searchText(
    input.organizationId,
    input.query,
    input.limit,
  );
  const semantic = rankSuggestionCandidates(
    candidates,
    embedding.vector,
    embedding.model,
    input.limit,
  );
  const seen = new Set(semantic.map((candidate) => candidate.id));
  return {
    mode: "semantic" as const,
    suggestions: [
      ...semantic,
      ...textMatches
        .filter((candidate) => !seen.has(candidate.id))
        .map((candidate) => serialize(candidate, null)),
    ].slice(0, input.limit),
  };
}
