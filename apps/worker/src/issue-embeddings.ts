import {
  issueEmbeddingText,
  listIssueSearchCandidates,
  searchIssuesByText,
  type IssueEmbedding,
} from "@responder/core/db/issues";
import OpenAI from "openai";

const defaultEmbeddingModel = "openai/text-embedding-3-small";

export function issueEmbeddingModel(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return environment.ISSUE_EMBEDDING_MODEL ?? defaultEmbeddingModel;
}

function openAiEmbeddingModel(model: string): string {
  return model.startsWith("openai/") ? model.slice("openai/".length) : model;
}

export function cosineSimilarity(left: number[], right: number[]): number {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

type IssueCandidate = Awaited<
  ReturnType<typeof listIssueSearchCandidates>
>[number];
type TextIssueCandidate = Awaited<ReturnType<typeof searchIssuesByText>>[number];

function serializeIssue<T extends number | null>(
  issue: Pick<
    IssueCandidate | TextIssueCandidate,
    | "id"
    | "title"
    | "description"
    | "rootCause"
    | "timeline"
    | "severity"
    | "remediation"
    | "evidence"
    | "createdAt"
  >,
  similarity: T,
) {
  return {
    id: issue.id,
    title: issue.title,
    description: issue.description,
    rootCause: issue.rootCause,
    timeline: issue.timeline,
    severity: issue.severity,
    remediation: issue.remediation,
    evidence: issue.evidence,
    similarity,
    createdAt: issue.createdAt.toISOString(),
  };
}

export function rankIssueCandidates(
  candidates: IssueCandidate[],
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
      serializeIssue(
        candidate,
        cosineSimilarity(queryEmbedding, candidate.embedding!),
      ),
    )
    .filter((candidate) => Number.isFinite(candidate.similarity))
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, limit);
}

interface IssueEmbeddingDependencies {
  createOpenAI: (apiKey: string) => Pick<OpenAI, "embeddings">;
  listCandidates: typeof listIssueSearchCandidates;
  searchText: typeof searchIssuesByText;
}

const defaultDependencies: IssueEmbeddingDependencies = {
  createOpenAI: (apiKey) => new OpenAI({ apiKey }),
  listCandidates: listIssueSearchCandidates,
  searchText: searchIssuesByText,
};

async function createEmbeddings(
  values: string[],
  environment: NodeJS.ProcessEnv,
  dependencies: IssueEmbeddingDependencies,
): Promise<{ model: string; vectors: number[][] }> {
  const apiKey = environment.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required");
  const model = issueEmbeddingModel(environment);
  const response = await dependencies.createOpenAI(apiKey).embeddings.create({
    input: values,
    model: openAiEmbeddingModel(model),
  });
  const vectors = [...response.data]
    .sort((left, right) => left.index - right.index)
    .map((item) => item.embedding);
  if (vectors.length !== values.length) {
    throw new Error("OpenAI returned an incomplete issue embedding response");
  }
  return { model, vectors };
}

export async function searchCanonicalIssues(
  input: { organizationId: string; query: string; limit: number },
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: IssueEmbeddingDependencies = defaultDependencies,
) {
  try {
    const [{ model, vectors }, candidates, textMatches] = await Promise.all([
      createEmbeddings([input.query], environment, dependencies),
      dependencies.listCandidates(input.organizationId),
      dependencies.searchText(input.organizationId, input.query, input.limit),
    ]);
    const semanticMatches = rankIssueCandidates(
      candidates,
      vectors[0]!,
      model,
      input.limit,
    );
    const seen = new Set(semanticMatches.map((issue) => issue.id));
    return {
      mode: "semantic" as const,
      issues: [
        ...semanticMatches,
        ...textMatches
          .filter((issue) => !seen.has(issue.id))
          .map((issue) => serializeIssue(issue, null)),
      ].slice(0, input.limit),
    };
  } catch {
    return {
      mode: "text" as const,
      issues: (
        await dependencies.searchText(
          input.organizationId,
          input.query,
          input.limit,
        )
      ).map((issue) => serializeIssue(issue, null)),
    };
  }
}

export async function embedNewIssues(
  issues: Array<{
    title: string;
    description: string;
    remediation: string;
  }>,
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: IssueEmbeddingDependencies = defaultDependencies,
): Promise<Array<IssueEmbedding | null>> {
  if (issues.length === 0) return [];
  try {
    const { model, vectors } = await createEmbeddings(
      issues.map(issueEmbeddingText),
      environment,
      dependencies,
    );
    return vectors.map((vector) => ({ model, vector }));
  } catch {
    return issues.map(() => null);
  }
}
