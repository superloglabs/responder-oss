import { tool } from "@openai/agents";
import { createSuggestionIfMissing, getSuggestionSettings } from "@responder/core/db/suggestions";
import { queueSuggestionPullRequests } from "@responder/core/db/suggestion-pull-requests";
import { suggestionSubmissionSchema } from "@responder/core/suggestions/model";
import { z } from "zod";
import type { CheckedOutRepository } from "./repositories.js";
import { attachRepositoryBasesToRemediations } from "./remediation-bases.js";
import { assertNoDaytonaSecretPlaceholders } from "./secret-safety.js";
import { embedSuggestion, searchCanonicalSuggestions } from "./suggestion-embeddings.js";

export function createSearchSuggestionsTool(input: {
  environment?: NodeJS.ProcessEnv;
  organizationId: string;
}) {
  return tool({
    name: "search_observability_suggestions",
    description:
      "Semantically search existing observability suggestions before creating a new one.",
    parameters: z.object({
      query: z.string().trim().min(1).max(4_000),
      limit: z.number().int().min(1).max(10).default(5),
    }),
    execute(query) {
      return searchCanonicalSuggestions(
        { organizationId: input.organizationId, ...query },
        input.environment,
      );
    },
  });
}

export function createSuggestionTool(input: {
  agentConfigVersionId: string;
  environment?: NodeJS.ProcessEnv;
  investigationId: string;
  onAutomaticPullRequestRequests?: (requestIds: string[]) => Promise<void>;
  organizationId: string;
  repositories: CheckedOutRepository[];
}) {
  return tool({
    name: "create_observability_suggestion",
    description:
      "Create an observability suggestion if no semantically equivalent suggestion exists. Search first. Use only when missing observability materially blocked or slowed this investigation.",
    parameters: suggestionSubmissionSchema,
    async execute(submission) {
      const codeChange = submission.codeChange
        ? attachRepositoryBasesToRemediations(
            [submission.codeChange],
            input.repositories,
          )[0]
        : undefined;
      if (codeChange && codeChange.type !== "code_change") {
        throw new Error("Suggestion code change is invalid");
      }
      const suggestion = {
        ...submission,
        ...(codeChange ? { codeChange } : {}),
      };
      assertNoDaytonaSecretPlaceholders(suggestion, "Observability suggestion");
      const embedding = await embedSuggestion(suggestion, input.environment);
      const result = await createSuggestionIfMissing({
        agentConfigVersionId: input.agentConfigVersionId,
        embedding,
        investigationId: input.investigationId,
        organizationId: input.organizationId,
        suggestion,
      });
      let automaticPullRequestRequestIds: string[] = [];
      if (result.created && suggestion.codeChange) {
        const settings = await getSuggestionSettings(input.organizationId);
        if (settings.autoOpenPullRequests) {
          const requests = await queueSuggestionPullRequests({
            organizationId: input.organizationId,
            suggestionId: result.suggestion.id,
          });
          automaticPullRequestRequestIds = requests.map((request) => request.id);
          await input.onAutomaticPullRequestRequests?.(
            automaticPullRequestRequestIds,
          );
        }
      }
      return {
        created: result.created,
        suggestion: {
          id: result.suggestion.id,
          title: result.suggestion.title,
          subtitle: result.suggestion.subtitle,
          codeChangeAvailable: Boolean(result.suggestion.codeChange),
        },
        automaticPullRequestRequestIds,
      };
    },
  });
}
